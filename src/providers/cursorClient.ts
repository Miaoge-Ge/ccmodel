/**
 * cursorClient.ts — optional helper that routes a model to Cursor's Composer via
 * the `cursor-agent` CLI. EXPERIMENTAL: cursor-agent is an autonomous agent with
 * its own tools, so we run it in read-only "ask" mode and bridge tool calls as
 * text markers the model emits and we parse back out. Plain Q&A/reasoning works
 * well; tool-calling is best-effort. Requires `cursor-agent login`.
 *
 * ENV KNOBS
 *   CURSOR_AGENT_BIN        path to the binary (default: PATH then ~/.local/bin)
 *   CURSOR_AGENT_WORKSPACE  workspace dir (default cwd)
 *   CURSOR_AGENT_TIMEOUT    seconds before giving up (default 240)
 *   CURSOR_AGENT_NO_PROXY   strip HTTP(S)_PROXY/ALL_PROXY from the child env
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { InternalEvent, OpenAIMessage } from "../config/types.js";
import { which } from "../core/which.js";
import { newToolId } from "../core/ids.js";

const MARKER_RE = /<CLAUDE_TOOL_CALL>\s*(\{[\s\S]*?\})\s*<\/CLAUDE_TOOL_CALL>/g;

type Json = Record<string, unknown>;
function isRecord(v: unknown): v is Json {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function findCursorAgent(): string | null {
  const explicit = process.env.CURSOR_AGENT_BIN;
  if (explicit) return existsSync(explicit) ? explicit : null;
  const onPath = which("cursor-agent");
  if (onPath) return onPath;
  const fallback = join(homedir(), ".local", "bin", "cursor-agent");
  return existsSync(fallback) ? fallback : null;
}

export function flattenMessages(messages: OpenAIMessage[]): { system: string; transcript: string } {
  const systemParts: string[] = [];
  const lines: string[] = [];
  for (const m of messages || []) {
    if (!isRecord(m)) continue;
    const role = m.role;
    const content = m.content;
    const text = typeof content === "string" ? content : JSON.stringify(content);
    if (role === "system") {
      systemParts.push(text);
    } else if (role === "tool") {
      lines.push(`TOOL RESULT (${String((m as Json).tool_call_id ?? "")}):\n${text}`);
    } else if (role === "assistant") {
      const tc = (m as Json).tool_calls;
      if (tc) lines.push(`ASSISTANT (called tools): ${JSON.stringify(tc)}`);
      if (text && text !== "None") lines.push(`ASSISTANT: ${text}`);
    } else {
      lines.push(`USER: ${text}`);
    }
  }
  return { system: systemParts.join("\n"), transcript: lines.join("\n\n") };
}

export function toolMarkerInstructions(tools: unknown): string {
  const names: string[] = [];
  for (const t of Array.isArray(tools) ? tools : []) {
    const fn = isRecord(t) && isRecord(t.function) ? (t.function as Json) : {};
    const n = (typeof fn.name === "string" && fn.name) || (isRecord(t) && typeof t.name === "string" ? t.name : "");
    if (n) names.push(String(n));
  }
  if (!names.length) return "";
  return (
    "\n\n--- TOOL BRIDGE INSTRUCTIONS ---\n" +
    "You are running as a backend for another coding agent that owns the real " +
    "tools. Do NOT use your own edit/shell tools. When you need to take an " +
    "action, instead emit a marker on its own line and stop:\n" +
    '<CLAUDE_TOOL_CALL>{"name":"<tool>","arguments":{...}}</CLAUDE_TOOL_CALL>\n' +
    "Available tools: " +
    names.join(", ") +
    "\nEmit one marker per action. If no tool is needed, just answer in plain text."
  );
}

/** Parse cursor-agent --output-format stream-json lines into text/error tuples. */
export function parseStream(lines: string[]): Array<["text" | "error", string]> {
  const out: Array<["text" | "error", string]> = [];
  let finalResult: string | null = null;
  const assistantText: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let obj: Json;
    try {
      const p = JSON.parse(line);
      if (!isRecord(p)) continue;
      obj = p;
    } catch {
      continue;
    }
    const t = obj.type;
    if (t === "assistant") {
      const msg = isRecord(obj.message) ? (obj.message as Json) : {};
      for (const block of Array.isArray(msg.content) ? msg.content : []) {
        if (isRecord(block) && block.type === "text") assistantText.push(typeof block.text === "string" ? block.text : "");
      }
    } else if (t === "result") {
      if (obj.is_error) {
        out.push(["error", String(obj.result ?? obj.error ?? "cursor-agent failed")]);
        return out;
      }
      if (typeof obj.result === "string") finalResult = obj.result;
    } else if (t === "error") {
      out.push(["error", String(obj.error ?? obj.message ?? "cursor-agent error")]);
      return out;
    }
  }
  const text = assistantText.join("").trim() || finalResult || "";
  if (text) out.push(["text", text]);
  return out;
}

export interface CursorParams {
  messages: OpenAIMessage[];
  tools?: unknown;
  model?: string;
  workspace?: string;
}

export async function* streamEvents(params: CursorParams): AsyncGenerator<InternalEvent> {
  let model = params.model || "composer-2.5";
  // Cursor removed Composer 2: coerce any legacy composer-2* (not 2.5) to 2.5.
  if (model.startsWith("composer-2") && !model.startsWith("composer-2.5")) model = "composer-2.5";

  const binp = findCursorAgent();
  if (!binp) {
    yield { type: "error", message: "cursor-agent not found; install it and run `cursor-agent login`.", status: 501 };
    return;
  }

  const { system, transcript } = flattenMessages(params.messages);
  let prompt = "";
  if (system) prompt += `SYSTEM:\n${system}\n\n`;
  prompt += transcript || "USER: (no content)";
  prompt += toolMarkerInstructions(params.tools);

  const ws = params.workspace || process.env.CURSOR_AGENT_WORKSPACE || process.cwd();
  const timeout = (Number.parseInt(process.env.CURSOR_AGENT_TIMEOUT || "240", 10) || 240) * 1000;
  const args = ["--print", "--output-format", "stream-json", "--model", model, "--mode", "ask", "--trust", "--workspace", ws, prompt];

  const env = { ...process.env };
  if (["1", "true", "yes"].includes((process.env.CURSOR_AGENT_NO_PROXY || "").toLowerCase())) {
    for (const v of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete env[v];
  }

  let result;
  try {
    result = spawnSync(binp, args, { env, timeout, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" });
  } catch (e) {
    yield { type: "error", message: `cursor-agent launch failed: ${String(e)}`, status: 502 };
    return;
  }
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    yield {
      type: "error",
      message:
        `cursor-agent timed out after ${timeout / 1000}s. It may be unable to reach Cursor's servers from here — ` +
        "if you're behind an intercepting HTTP(S) proxy, set CURSOR_AGENT_NO_PROXY=1.",
      status: 504,
    };
    return;
  }
  if (result.error) {
    yield { type: "error", message: `cursor-agent launch failed: ${String(result.error)}`, status: 502 };
    return;
  }

  const stdout = (result.stdout ? result.stdout.toString("utf-8") : "").split(/\r?\n/);
  const textChunks: string[] = [];
  for (const [kind, val] of parseStream(stdout)) {
    if (kind === "error") {
      yield { type: "error", message: val, status: 502 };
      return;
    }
    if (kind === "text") textChunks.push(val);
  }
  const full = textChunks.join("\n");

  if (!full.trim()) {
    const detail = (result.stderr ? result.stderr.toString("utf-8") : "").slice(0, 300);
    yield {
      type: "error",
      message: `cursor-agent produced no output. ${detail || "(it may be unable to reach Cursor's servers from this environment)"}`,
      status: 502,
    };
    return;
  }

  // Extract bridged tool-call markers, strip them from the visible text.
  const toolCalls: Array<{ name: string; arguments: string }> = [];
  for (const m of full.matchAll(MARKER_RE)) {
    try {
      const obj = JSON.parse(m[1]!);
      toolCalls.push({
        name: (isRecord(obj) && typeof obj.name === "string" ? obj.name : "") || "",
        arguments: JSON.stringify(isRecord(obj) ? (obj.arguments ?? {}) : {}),
      });
    } catch {
      // ignore malformed marker
    }
  }
  const visible = full.replace(MARKER_RE, "").trim();

  if (visible) yield { type: "text_delta", text: visible };
  for (const tc of toolCalls) yield { type: "tool_call", id: newToolId(), name: tc.name, arguments: tc.arguments };
  yield { type: "usage", input_tokens: 0, output_tokens: 0 };
}
