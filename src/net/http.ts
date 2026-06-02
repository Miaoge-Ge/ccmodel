/**
 * Minimal streaming HTTP client over node:http / node:https.
 *
 * Unlike fetch, this never throws on a 4xx/5xx — it resolves with the response
 * and its status so the caller decides. The socket inactivity timeout doubles
 * as a connect deadline and a per-chunk idle timeout while streaming, so a
 * stalled upstream (e.g. a silent SSE mid-turn) fails fast instead of hanging.
 *
 * Supports an AbortSignal (to cancel when the downstream client disconnects) and
 * a small transient-connect retry so a flaky DNS/TCP hiccup doesn't surface as a
 * user-visible 502.
 */
import httpMod from "node:http";
import httpsMod from "node:https";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { URL } from "node:url";

/**
 * Pooled keep-alive agents. A proxy makes many upstream calls to the same few
 * hosts; reusing sockets avoids a TCP+TLS handshake on every request (a real
 * latency win on streaming workloads). `maxSockets` is generous so concurrent
 * subagent traffic doesn't queue behind the pool.
 */
const AGENT_OPTS = { keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 256, scheduling: "fifo" as const };
const httpAgent = new httpMod.Agent(AGENT_OPTS);
const httpsAgent = new httpsMod.Agent(AGENT_OPTS);

export interface UpstreamResponse {
  status: number;
  headers: IncomingHttpHeaders;
  contentType: string;
  /** Raw response stream (an IncomingMessage, also AsyncIterable<Buffer>). */
  raw: IncomingMessage;
  /** Yield response body as Buffer chunks. */
  chunks(): AsyncGenerator<Buffer>;
  /** Read the whole response body as a UTF-8 string. */
  text(): Promise<string>;
}

export interface RequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string | undefined>;
  body?: Buffer | string | null;
  /** Socket inactivity timeout (ms): connect deadline + per-chunk idle. */
  timeoutMs?: number;
  /** Cancel the in-flight request (e.g. the downstream client went away). */
  signal?: AbortSignal;
  /** Transient connect/socket-error retries before rejecting (default 1). */
  connectRetries?: number;
}

function cleanHeaders(headers: Record<string, string | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/** True for errors worth a quick retry (DNS/TCP reset/refused), not aborts. */
function transientConnectError(err: NodeJS.ErrnoException): boolean {
  return ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPIPE"].includes(err.code || "");
}

function once(opts: RequestOptions): Promise<UpstreamResponse> {
  const u = new URL(opts.url);
  const isHttps = u.protocol === "https:";
  const mod = isHttps ? httpsMod : httpMod;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const bodyBuf =
    opts.body == null ? null : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, "utf-8");

  return new Promise<UpstreamResponse>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: opts.method || "GET",
        headers: cleanHeaders(opts.headers),
        agent: isHttps ? httpsAgent : httpAgent,
      },
      (res: IncomingMessage) => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          contentType: String(res.headers["content-type"] || ""),
          raw: res,
          async *chunks(): AsyncGenerator<Buffer> {
            for await (const chunk of res) yield chunk as Buffer;
          },
          text(): Promise<string> {
            return new Promise<string>((resTxt, rejTxt) => {
              const parts: Buffer[] = [];
              res.on("data", (c: Buffer) => parts.push(c));
              res.on("end", () => resTxt(Buffer.concat(parts).toString("utf-8")));
              res.on("error", rejTxt);
            });
          },
        });
      },
    );

    const onAbort = (): void => {
      req.destroy(new Error("aborted"));
    };
    if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });
    req.on("close", () => opts.signal?.removeEventListener("abort", onAbort));

    // Socket inactivity timeout: fires if no bytes flow for timeoutMs. Resets on
    // every chunk, so a healthy stream stays open and only a true stall trips it.
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`upstream timeout after ${timeoutMs}ms (no activity)`)));
    req.on("error", reject);

    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

export async function requestUpstream(opts: RequestOptions): Promise<UpstreamResponse> {
  const retries = opts.connectRetries ?? 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await once(opts);
    } catch (e) {
      lastErr = e;
      const err = e as NodeJS.ErrnoException;
      // Never retry an intentional abort, and stop once retries are exhausted.
      if (opts.signal?.aborted || err.message === "aborted" || attempt >= retries || !transientConnectError(err)) {
        throw e;
      }
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
  throw lastErr;
}
