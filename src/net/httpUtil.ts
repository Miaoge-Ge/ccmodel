/** HTTP helpers shared by the server and providers. */
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

export const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "accept-encoding",
]);

export function flatten(v: string | string[] | undefined): string {
  if (v === undefined) return "";
  return Array.isArray(v) ? v.join(", ") : v;
}

/** Copy inbound headers minus hop-by-hop, forcing identity encoding. */
export function forwardRequestHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = flatten(v as string | string[] | undefined);
  }
  out["Accept-Encoding"] = "identity";
  return out;
}

/**
 * Apply a route's auth override. Strips whatever credential the inbound client
 * sent (Authorization / x-api-key) so the backend sees only our override.
 *   "Bearer xyz"          -> Authorization: Bearer xyz
 *   "x-api-key: xyz"      -> x-api-key: xyz
 */
export function applyAuthHeader(headers: Record<string, string>, auth: string): void {
  for (const k of Object.keys(headers)) {
    const kl = k.toLowerCase();
    if (kl === "authorization" || kl === "x-api-key") delete headers[k];
  }
  if (auth.includes(":") && !auth.toLowerCase().startsWith("bearer")) {
    const idx = auth.indexOf(":");
    headers[auth.slice(0, idx).trim()] = auth.slice(idx + 1).trim();
  } else {
    headers["Authorization"] = auth;
  }
}

/** Thrown by readBody when the inbound body exceeds the configured cap. */
export class BodyTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`request body exceeds the ${limit}-byte limit`);
    this.name = "BodyTooLargeError";
  }
}

/**
 * Buffer the request body, rejecting with BodyTooLargeError once it exceeds
 * `maxBytes` (0 disables the cap). Bounds memory so a runaway/hostile client
 * can't OOM the proxy with an unbounded upload.
 */
export function readBody(req: IncomingMessage, maxBytes = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let total = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      if (over) return;
      total += c.length;
      if (maxBytes > 0 && total > maxBytes) {
        over = true;
        reject(new BodyTooLargeError(maxBytes));
        // Drain (not destroy) the rest so the socket stays usable for the caller
        // to write a 413 response back.
        req.resume();
        return;
      }
      parts.push(c);
    });
    req.on("end", () => {
      if (!over) resolve(Buffer.concat(parts));
    });
    req.on("error", (e) => {
      if (!over) reject(e);
    });
  });
}

export function sendRaw(res: ServerResponse, status: number, ctype: string, payload: Buffer): void {
  try {
    res.writeHead(status, { "Content-Type": ctype, "Content-Length": String(payload.length) });
    res.end(payload);
  } catch {
    // client gone
  }
}

export function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  sendRaw(res, status, "application/json", Buffer.from(JSON.stringify(obj), "utf-8"));
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { type: "error", error: { type: "proxy_error", message } });
}
