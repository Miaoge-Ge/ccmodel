/**
 * Shared Anthropic emitters: turn the internal event stream into either an
 * Anthropic SSE stream or a single Anthropic JSON message, writing to the
 * client ServerResponse. Used by the openai_compat, codex and cursor paths.
 */
import type { ServerResponse } from "node:http";
import type { InternalEvent } from "../config/types.js";
import { sseFrame, parseToolInput } from "./sse.js";
import { newMsgId, newToolId } from "../core/ids.js";
import { vlog } from "../core/log.js";

type Json = Record<string, unknown>;

export async function streamAnthropicFromEvents(
  res: ServerResponse,
  events: AsyncGenerator<InternalEvent>,
  modelId: string,
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "close",
  });

  const msgId = newMsgId();
  res.write(
    sseFrame("message_start", {
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        model: modelId,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }),
  );

  let index = 0;
  let textOpen = false;
  let emitted = false;
  let stopReason = "end_turn";
  let outTok = 0;

  const openText = (): void => {
    res.write(
      sseFrame("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      }),
    );
    textOpen = true;
  };
  const closeBlock = (): void => {
    res.write(sseFrame("content_block_stop", { type: "content_block_stop", index }));
  };

  try {
    for await (const ev of events) {
      if (ev.type === "text_delta") {
        const txt = ev.text || "";
        if (!txt) continue;
        if (!textOpen) openText();
        res.write(
          sseFrame("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: txt },
          }),
        );
        emitted = true;
      } else if (ev.type === "tool_call") {
        if (textOpen) {
          closeBlock();
          index += 1;
          textOpen = false;
        }
        res.write(
          sseFrame("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id: ev.id || newToolId(), name: ev.name || "", input: {} },
          }),
        );
        res.write(
          sseFrame("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: ev.arguments || "{}" },
          }),
        );
        closeBlock();
        index += 1;
        emitted = true;
        stopReason = "tool_use";
      } else if (ev.type === "usage") {
        outTok = ev.output_tokens ?? outTok;
      } else if (ev.type === "error") {
        if (!emitted) {
          if (!textOpen) openText();
          res.write(
            sseFrame("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "text_delta", text: "[ccmodel] " + (ev.message || "upstream error") },
            }),
          );
          emitted = true;
        }
        break;
      }
    }
    if (textOpen) {
      closeBlock();
    } else if (!emitted) {
      openText();
      closeBlock();
    }
  } catch (e) {
    vlog(`anthropic stream relay ended: ${String(e)}`);
  }

  res.write(
    sseFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outTok },
    }),
  );
  res.write(sseFrame("message_stop", { type: "message_stop" }));
  res.end();
}

export async function jsonAnthropicFromEvents(
  res: ServerResponse,
  events: AsyncGenerator<InternalEvent>,
  modelId: string,
  sendError: (status: number, message: string) => void,
): Promise<void> {
  let fullText = "";
  const toolBlocks: Json[] = [];
  let inTok = 0;
  let outTok = 0;
  let err: { message: string; status?: number } | null = null;

  for await (const ev of events) {
    if (ev.type === "text_delta") {
      fullText += ev.text || "";
    } else if (ev.type === "tool_call") {
      toolBlocks.push({
        type: "tool_use",
        id: ev.id || newToolId(),
        name: ev.name || "",
        input: parseToolInput(ev.arguments || "{}"),
      });
    } else if (ev.type === "usage") {
      inTok = Math.max(inTok, ev.input_tokens || 0);
      outTok = Math.max(outTok, ev.output_tokens || 0);
    } else if (ev.type === "error" && !fullText && toolBlocks.length === 0) {
      err = { message: ev.message, status: ev.status };
    }
  }

  if (err) {
    sendError(err.status ?? 502, err.message || "upstream error");
    return;
  }

  const content: Json[] = [];
  if (fullText) content.push({ type: "text", text: fullText });
  content.push(...toolBlocks);
  if (content.length === 0) content.push({ type: "text", text: "" });

  const out = {
    id: newMsgId(),
    type: "message",
    role: "assistant",
    model: modelId,
    content,
    stop_reason: toolBlocks.length ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: inTok, output_tokens: outTok },
  };
  const payload = Buffer.from(JSON.stringify(out), "utf-8");
  res.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(payload.length) });
  res.end(payload);
}
