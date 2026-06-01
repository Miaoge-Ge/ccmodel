/**
 * codexClient.ts — route a model to GPT-5.5 (and other Codex models) using a
 * ChatGPT/Codex *login* instead of an API key. Reuses the credentials written
 * by the official Codex CLI (`codex login` -> ~/.codex/auth.json), talks to the
 * Codex Responses API, and converts the result into the proxy's event vocabulary.
 *
 * ENV KNOBS
 *   CODEX_HOME                    dir holding auth.json (default ~/.codex)
 *   UC_CODEX_BASE_URL             Codex API base (default chatgpt.com/backend-api/codex)
 *   UC_CODEX_EFFORT               reasoning effort (default medium)
 *   UC_CODEX_SERVICE_TIER         optional service tier (e.g. priority)
 *   UC_CODEX_REFRESH_CMD          best-effort refresh cmd (default "codex login status")
 *   UC_CODEX_STREAM_IDLE_TIMEOUT  per-read idle timeout, seconds (default 150)
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { InternalEvent, OpenAIMessage } from "../config/types.js";
import { requestUpstream } from "../net/http.js";

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const AUTH_FILE = join(CODEX_HOME, "auth.json");
const BASE_URL = (process.env.UC_CODEX_BASE_URL || "https://chatgpt.com/backend-api/codex").replace(/\/+$/, "");
const RESPONSES_URL = BASE_URL + "/responses";
const DEFAULT_EFFORT = process.env.UC_CODEX_EFFORT || "medium";
const SERVICE_TIER = (process.env.UC_CODEX_SERVICE_TIER || "").trim();
const REFRESH_CMD = process.env.UC_CODEX_REFRESH_CMD ?? "codex login status";
const STREAM_IDLE_TIMEOUT = Number.parseFloat(process.env.UC_CODEX_STREAM_IDLE_TIMEOUT || "150") || 150;

export function codexAuthAvailable(): boolean {
  try {
    readFileSync(AUTH_FILE, "utf-8");
    return true;
  } catch {
    return false;
  }
}

export const CODEX_AUTH_FILE = AUTH_FILE;

class CodexAuthError extends Error {}

type Json = Record<string, unknown>;
function isRecord(v: unknown): v is Json {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function loadAuth(): Json {
  let txt: string;
  try {
    txt = readFileSync(AUTH_FILE, "utf-8");
  } catch {
    throw new CodexAuthError(`no ${AUTH_FILE} — run \`codex login\` first (install the Codex CLI if needed).`);
  }
  try {
    const parsed = JSON.parse(txt);
    if (!isRecord(parsed)) throw new Error("not an object");
    return parsed;
  } catch (e) {
    throw new CodexAuthError(`could not read ${AUTH_FILE}: ${String(e)}`);
  }
}

function decodeJwtClaims(token: string): Json {
  try {
    const payload = token.split(".")[1] ?? "";
    const padded = payload + "=".repeat((-payload.length % 4 + 4) % 4);
    const json = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
    const obj = JSON.parse(json);
    return isRecord(obj) ? obj : {};
  } catch {
    return {};
  }
}

function accountId(token: string): string | undefined {
  const claims = decodeJwtClaims(token);
  const auth = isRecord(claims["https://api.openai.com/auth"]) ? (claims["https://api.openai.com/auth"] as Json) : {};
  const id = auth.chatgpt_account_id;
  return typeof id === "string" ? id : undefined;
}

function isExpiring(token: string, skew = 120): boolean {
  const claims = decodeJwtClaims(token);
  const exp = claims.exp;
  if (typeof exp !== "number") return false;
  return Date.now() / 1000 >= exp - skew;
}

function bestEffortRefresh(): void {
  if (!REFRESH_CMD) return;
  const parts = REFRESH_CMD.split(/\s+/).filter(Boolean);
  if (!parts.length) return;
  try {
    spawnSync(parts[0]!, parts.slice(1), { timeout: 25_000, stdio: "ignore" });
  } catch {
    // ignore
  }
}

function accessToken(): string {
  let state = loadAuth();
  const tokens = isRecord(state.tokens) ? (state.tokens as Json) : {};
  let token = typeof tokens.access_token === "string" ? tokens.access_token : "";
  if (!token) {
    throw new CodexAuthError(`no access_token in ${AUTH_FILE} — run \`codex login\`.`);
  }
  if (isExpiring(token)) {
    bestEffortRefresh();
    state = loadAuth();
    const refreshed = isRecord(state.tokens) ? (state.tokens as Json).access_token : "";
    if (typeof refreshed === "string" && refreshed) token = refreshed;
    if (isExpiring(token)) {
      throw new CodexAuthError("Codex token expired — run `codex login` to refresh.");
    }
  }
  return token;
}

function headers(token: string): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": "codex_cli_rs/0.0.0",
    originator: "codex_cli_rs",
    "OpenAI-Beta": "responses=experimental",
  };
  const acc = accountId(token);
  if (acc) h["ChatGPT-Account-ID"] = acc;
  return h;
}

function messagesToResponsesInput(messages: OpenAIMessage[]): { instructions: string; items: Json[] } {
  const instructions: string[] = [];
  const items: Json[] = [];
  for (const m of messages || []) {
    if (!isRecord(m)) continue;
    const role = m.role;
    const content = m.content;
    if (role === "system") {
      if (typeof content === "string" && content) instructions.push(content);
      continue;
    }
    if (role === "tool") {
      items.push({
        type: "function_call_output",
        call_id: (m as Json).tool_call_id || "call_unknown",
        output: typeof content === "string" ? content : JSON.stringify(content),
      });
      continue;
    }
    if (role === "assistant") {
      if (typeof content === "string" && content) {
        items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: content }] });
      }
      const toolCalls = Array.isArray((m as Json).tool_calls) ? ((m as Json).tool_calls as Json[]) : [];
      for (const tc of toolCalls) {
        const fn = isRecord(tc.function) ? (tc.function as Json) : {};
        items.push({
          type: "function_call",
          call_id: tc.id || "call_unknown",
          name: fn.name || "",
          arguments: fn.arguments || "{}",
        });
      }
      continue;
    }
    // user / default
    const text = typeof content === "string" ? content : JSON.stringify(content);
    items.push({ type: "message", role: "user", content: [{ type: "input_text", text }] });
  }
  return { instructions: instructions.join("\n\n"), items };
}

function toolsToResponses(tools: unknown): Json[] {
  const out: Json[] = [];
  for (const t of Array.isArray(tools) ? tools : []) {
    if (!isRecord(t)) continue;
    const fn = isRecord(t.function) ? (t.function as Json) : {};
    const name = fn.name;
    if (!name || typeof name !== "string") continue;
    out.push({
      type: "function",
      name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters: isRecord(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
      strict: false,
    });
  }
  return out;
}

function toolChoiceToResponses(tc: unknown): unknown {
  if (tc === "auto" || tc === "required" || tc === "none") return tc;
  if (isRecord(tc) && tc.type === "function") {
    const name = isRecord(tc.function) ? (tc.function as Json).name : undefined;
    if (typeof name === "string" && name) return { type: "function", name };
  }
  return "auto";
}

export interface CodexParams {
  messages: OpenAIMessage[];
  tools?: unknown;
  tool_choice?: unknown;
  model?: string;
  reasoning_effort?: string;
  service_tier?: string;
  /** Cancel the upstream call when the downstream client disconnects. */
  signal?: AbortSignal;
}

export async function* streamEvents(params: CodexParams): AsyncGenerator<InternalEvent> {
  const model = params.model || "gpt-5.5";
  let token: string;
  try {
    token = accessToken();
  } catch (e) {
    yield { type: "error", message: e instanceof Error ? e.message : String(e), status: 401 };
    return;
  }

  const { instructions, items } = messagesToResponsesInput(params.messages);
  const body: Json = {
    model,
    instructions,
    input: items,
    store: false,
    stream: true,
    parallel_tool_calls: true,
    reasoning: { effort: params.reasoning_effort || DEFAULT_EFFORT },
  };
  const respTools = toolsToResponses(params.tools);
  if (respTools.length) {
    body.tools = respTools;
    body.tool_choice = toolChoiceToResponses(params.tool_choice);
  }
  const tier = params.service_tier || SERVICE_TIER;
  if (tier) body.service_tier = tier;

  const payload = Buffer.from(JSON.stringify(body), "utf-8");
  const h = headers(token);
  h["Content-Length"] = String(payload.length);

  let resp;
  try {
    resp = await requestUpstream({
      url: RESPONSES_URL,
      method: "POST",
      headers: h,
      body: payload,
      timeoutMs: STREAM_IDLE_TIMEOUT * 1000,
      signal: params.signal,
    });
  } catch (e) {
    if (params.signal?.aborted) return; // client went away
    yield { type: "error", message: `Codex API error: ${String(e)}`, status: 502 };
    return;
  }
  if (resp.status >= 400) {
    let detail = "";
    try {
      detail = (await resp.text()).slice(0, 500);
    } catch {
      // ignore
    }
    yield { type: "error", message: `Codex API HTTP ${resp.status}: ${detail}`, status: resp.status };
    return;
  }

  const pending = new Map<string, { name: string; args: string }>();
  const alias = new Map<string, string>();
  let buf = Buffer.alloc(0);
  let inTok = 0;
  let outTok = 0;
  const NL = 0x0a;

  try {
    outer: for await (const chunk of resp.chunks()) {
      buf = Buffer.concat([buf, chunk]);
      let nl: number;
      while ((nl = buf.indexOf(NL)) !== -1) {
        const line = buf.subarray(0, nl).toString("utf-8").trim();
        buf = buf.subarray(nl + 1);
        if (!line || !line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          buf = Buffer.alloc(0);
          break outer;
        }
        let obj: Json;
        try {
          const p = JSON.parse(data);
          if (!isRecord(p)) continue;
          obj = p;
        } catch {
          continue;
        }
        const et = typeof obj.type === "string" ? obj.type : "";
        if (et === "response.output_text.delta") {
          const d = obj.delta;
          if (typeof d === "string" && d) yield { type: "text_delta", text: d };
        } else if (et === "response.output_item.added") {
          const item = isRecord(obj.item) ? (obj.item as Json) : {};
          if (item.type === "function_call") {
            const callId = typeof item.call_id === "string" ? item.call_id : "";
            const itemId = typeof item.id === "string" ? item.id : "";
            const canon = callId || itemId;
            if (callId) alias.set(callId, canon);
            if (itemId) alias.set(itemId, canon);
            pending.set(canon, {
              name: typeof item.name === "string" ? item.name : "",
              args: typeof item.arguments === "string" ? item.arguments : "",
            });
          }
        } else if (et === "response.function_call_arguments.delta") {
          const raw = (typeof obj.call_id === "string" && obj.call_id) || (typeof obj.item_id === "string" && obj.item_id) || "";
          const canon = alias.get(raw) ?? raw;
          let slot = pending.get(canon);
          if (!slot) {
            slot = { name: "", args: "" };
            pending.set(canon, slot);
          }
          if (typeof obj.delta === "string") slot.args += obj.delta;
        } else if (et === "response.output_item.done") {
          const item = isRecord(obj.item) ? (obj.item as Json) : {};
          if (item.type === "function_call") {
            const callId = typeof item.call_id === "string" ? item.call_id : "";
            const itemId = typeof item.id === "string" ? item.id : "";
            const canon = alias.get(callId) ?? alias.get(itemId) ?? callId ?? itemId;
            const slot = pending.get(canon) ?? { name: "", args: "" };
            const name = (typeof item.name === "string" && item.name) || slot.name || "";
            const args = (typeof item.arguments === "string" && item.arguments) || slot.args || "{}";
            yield { type: "tool_call", id: canon || null, name, arguments: args };
            pending.delete(canon);
          }
        } else if (et === "response.completed" || et === "response.done" || et === "response.incomplete") {
          const respObj = isRecord(obj.response) ? (obj.response as Json) : {};
          const usage = isRecord(respObj.usage) ? (respObj.usage as Json) : {};
          if (typeof usage.input_tokens === "number") inTok = usage.input_tokens;
          if (typeof usage.output_tokens === "number") outTok = usage.output_tokens;
        } else if (et === "error" || et === "response.failed") {
          const err = isRecord(obj.error) ? (obj.error as Json) : {};
          yield { type: "error", message: (typeof err.message === "string" && err.message) || "Codex stream error", status: 502 };
        }
      }
    }
  } catch (e) {
    yield { type: "error", message: `Codex stream relay ended: ${String(e)}`, status: 502 };
    return;
  }

  // Flush any tool calls that got an added/delta but never a 'done'. Require a name.
  for (const [cid, slot] of pending) {
    if (slot.name) {
      yield { type: "tool_call", id: cid || null, name: slot.name, arguments: slot.args || "{}" };
    }
  }
  if (inTok || outTok) yield { type: "usage", input_tokens: inTok, output_tokens: outTok };
}
