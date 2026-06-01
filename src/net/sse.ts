/**
 * SSE helpers + the OpenAI-response -> internal-event parser.
 *
 * Internal event vocabulary (shared by every backend path):
 *   { type: "text_delta", text }
 *   { type: "tool_call", id, name, arguments }   // arguments is a JSON string
 *   { type: "usage", input_tokens, output_tokens }
 *   { type: "error", message, status }
 */
import type { InternalEvent } from "../config/types.js";
import type { UpstreamResponse } from "./http.js";

/** Format one Anthropic SSE frame. */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function stopReasonFor(finish: string | undefined): string {
  switch (finish) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stop":
      return "end_turn";
    default:
      return "end_turn";
  }
}

export function parseToolInput(raw: string | undefined): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return { input: raw || "" };
  }
}

type Json = Record<string, unknown>;
function isRecord(v: unknown): v is Json {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Yield internal events from an OpenAI response (SSE stream or plain JSON). */
export async function* oaiResponseToEvents(resp: UpstreamResponse): AsyncGenerator<InternalEvent> {
  if (resp.contentType.includes("text/event-stream")) {
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let buf = Buffer.alloc(0);
    let finishedUsage: { input_tokens: number; output_tokens: number } | null = null;

    const NL = 0x0a;
    outer: for await (const chunk of resp.chunks()) {
      buf = Buffer.concat([buf, chunk]);
      let nl: number;
      while ((nl = buf.indexOf(NL)) !== -1) {
        const line = buf.subarray(0, nl).toString("utf-8").trim();
        buf = buf.subarray(nl + 1);
        if (!line || !line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          buf = Buffer.alloc(0);
          break outer;
        }
        let obj: Json;
        try {
          const p = JSON.parse(payload);
          if (!isRecord(p)) continue;
          obj = p;
        } catch {
          continue;
        }
        const choices = Array.isArray(obj.choices) ? obj.choices : [];
        const choice = isRecord(choices[0]) ? (choices[0] as Json) : {};
        const delta = isRecord(choice.delta) ? (choice.delta as Json) : {};
        const piece = delta.content;
        if (typeof piece === "string" && piece) yield { type: "text_delta", text: piece };
        const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        for (const tc of toolCalls) {
          if (!isRecord(tc)) continue;
          const idx = typeof tc.index === "number" ? tc.index : 0;
          let slot = pending.get(idx);
          if (!slot) {
            slot = { id: "", name: "", args: "" };
            pending.set(idx, slot);
          }
          if (typeof tc.id === "string" && tc.id) slot.id = tc.id;
          const fn = isRecord(tc.function) ? (tc.function as Json) : {};
          if (typeof fn.name === "string" && fn.name) slot.name = fn.name;
          if (typeof fn.arguments === "string") slot.args += fn.arguments;
        }
        if (isRecord(obj.usage)) {
          const u = obj.usage as Json;
          finishedUsage = {
            input_tokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0,
            output_tokens: typeof u.completion_tokens === "number" ? u.completion_tokens : 0,
          };
        }
      }
    }
    for (const idx of [...pending.keys()].sort((a, b) => a - b)) {
      const slot = pending.get(idx)!;
      if (slot.name || slot.args) {
        yield { type: "tool_call", id: slot.id, name: slot.name, arguments: slot.args || "{}" };
      }
    }
    if (finishedUsage) yield { type: "usage", ...finishedUsage };
    return;
  }

  // Plain JSON response.
  let oai: Json;
  try {
    const p = JSON.parse(await resp.text());
    oai = isRecord(p) ? p : {};
  } catch (e) {
    yield { type: "error", message: `bad upstream JSON: ${String(e)}`, status: 502 };
    return;
  }
  const choices = Array.isArray(oai.choices) ? oai.choices : [];
  const choice = isRecord(choices[0]) ? (choices[0] as Json) : {};
  const msg = isRecord(choice.message) ? (choice.message as Json) : {};
  const text = typeof msg.content === "string" ? msg.content : "";
  if (text) yield { type: "text_delta", text };
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  for (const tc of toolCalls) {
    if (!isRecord(tc)) continue;
    const fn = isRecord(tc.function) ? (tc.function as Json) : {};
    const name = typeof fn.name === "string" ? fn.name : "";
    const rawArgs = typeof fn.arguments === "string" ? fn.arguments : "";
    if (!name && !rawArgs) continue; // skip empty tool_calls (matches the streaming path)
    yield { type: "tool_call", id: typeof tc.id === "string" ? tc.id : "", name, arguments: rawArgs || "{}" };
  }
  const usage = isRecord(oai.usage) ? (oai.usage as Json) : {};
  yield {
    type: "usage",
    input_tokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
    output_tokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
  };
}
