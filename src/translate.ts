/**
 * Anthropic <-> OpenAI translation, with tool-calling preserved both ways.
 *
 * The fiddly part is tool-call adjacency: OpenAI (and strict backends like
 * DeepSeek) require every assistant message carrying `tool_calls` to be
 * IMMEDIATELY followed by exactly one `tool` message per tool_call_id. Claude
 * Code breaks that when a call is rejected-with-a-comment (it puts the user text
 * alongside/ahead of the tool_result) or when a parallel/rejected call gets no
 * result at all. We emit tool replies first, in order, and synthesize a stub for
 * any id the client didn't answer, so strict backends never see an orphaned
 * tool_calls turn.
 */
import { randomHex } from "./ids.js";
import type { OpenAIBody, OpenAIMessage } from "./types.js";

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function textFromAnthropicContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
    } else if (isRecord(block)) {
      const btype = block.type;
      if (btype === "text") parts.push(String(block.text ?? ""));
      else if (btype === "tool_result") parts.push(textFromAnthropicContent(block.content));
      else if (btype === "image") parts.push("[image omitted]");
    }
  }
  return parts.filter((p) => p).join("\n");
}

function anthropicToolsToOai(tools: unknown): OpenAIBody["tools"] {
  const out: NonNullable<OpenAIBody["tools"]> = [];
  if (!Array.isArray(tools)) return undefined;
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    const name = tool.name;
    if (!name || typeof name !== "string") continue;
    out.push({
      type: "function",
      function: {
        name,
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: isRecord(tool.input_schema) ? tool.input_schema : { type: "object", properties: {} },
      },
    });
  }
  return out.length ? out : undefined;
}

function anthropicToolChoiceToOai(tc: unknown): unknown {
  if (!isRecord(tc)) return null;
  const t = tc.type;
  if (t === "auto") return "auto";
  if (t === "any") return "required";
  if (t === "tool" && typeof tc.name === "string") return { type: "function", function: { name: tc.name } };
  if (t === "none") return "none";
  return null;
}

export function anthropicToOpenai(body: Json): OpenAIBody {
  const messages: OpenAIMessage[] = [];

  const system = body.system;
  if (typeof system === "string" && system.trim()) {
    messages.push({ role: "system", content: system });
  } else if (Array.isArray(system)) {
    const sysTxt = textFromAnthropicContent(system);
    if (sysTxt.trim()) messages.push({ role: "system", content: sysTxt });
  }

  // Ids awaiting a tool reply; mutated in place so the closure stays valid.
  const pendingToolIds: string[] = [];

  const flushToolReplies = (byId: Map<string, Json>): void => {
    for (const tid of pendingToolIds) {
      const tr = byId.get(tid);
      if (tr !== undefined) {
        byId.delete(tid);
        messages.push({
          role: "tool",
          tool_call_id: tid,
          content: textFromAnthropicContent(tr.content) || "(no output)",
        });
      } else {
        messages.push({
          role: "tool",
          tool_call_id: tid,
          content: "Tool call was not executed (rejected or skipped by the user).",
        });
      }
    }
    // Stray results that didn't match a pending id (unusual) — keep them anyway.
    for (const [tid, tr] of byId) {
      messages.push({
        role: "tool",
        tool_call_id: tid || "call_unknown",
        content: textFromAnthropicContent(tr.content) || "(no output)",
      });
    }
    pendingToolIds.length = 0;
  };

  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  for (const m of rawMessages) {
    if (!isRecord(m)) continue;
    let role = typeof m.role === "string" ? m.role : "user";
    const content = m.content ?? "";

    // Pending tool calls are only legitimately answered by the NEXT user turn.
    if (pendingToolIds.length && role !== "user") {
      flushToolReplies(new Map());
    }

    if (role === "assistant" && Array.isArray(content)) {
      const textParts: string[] = [];
      const toolCalls: NonNullable<OpenAIMessage["tool_calls"]> = [];
      for (const block of content) {
        if (!isRecord(block)) {
          if (block) textParts.push(String(block));
          continue;
        }
        const btype = block.type;
        if (btype === "text") {
          textParts.push(String(block.text ?? ""));
        } else if (btype === "tool_use") {
          toolCalls.push({
            id: (typeof block.id === "string" && block.id) || "call_" + randomHex(12),
            type: "function",
            function: {
              name: typeof block.name === "string" ? block.name : "",
              arguments: JSON.stringify(isRecord(block.input) ? block.input : {}),
            },
          });
        }
      }
      const entry: OpenAIMessage = { role: "assistant", content: textParts.filter((p) => p).join("\n") };
      if (toolCalls.length) {
        entry.tool_calls = toolCalls;
        pendingToolIds.length = 0;
        for (const tc of toolCalls) pendingToolIds.push(tc.id);
      }
      messages.push(entry);
      continue;
    }

    if (role === "user") {
      let toolResults: Json[] = [];
      let text: string;
      if (Array.isArray(content)) {
        toolResults = content.filter((b): b is Json => isRecord(b) && b.type === "tool_result");
        const textBlocks = content.filter((b) => !(isRecord(b) && b.type === "tool_result"));
        text = textFromAnthropicContent(textBlocks);
      } else {
        text = typeof content === "string" ? content : textFromAnthropicContent(content);
      }

      // 1. Tool replies FIRST — immediately after the assistant's tool_calls.
      if (pendingToolIds.length) {
        const byId = new Map<string, Json>();
        for (const tr of toolResults) {
          const key = (typeof tr.tool_use_id === "string" && tr.tool_use_id) || "call_unknown";
          if (!byId.has(key)) byId.set(key, tr);
        }
        flushToolReplies(byId);
      } else {
        for (const tr of toolResults) {
          messages.push({
            role: "tool",
            tool_call_id: (typeof tr.tool_use_id === "string" && tr.tool_use_id) || "call_unknown",
            content: textFromAnthropicContent(tr.content) || "(no output)",
          });
        }
      }

      // 2. THEN the user's own text (e.g. the rejection comment).
      if (text) messages.push({ role: "user", content: text });
      continue;
    }

    if (role !== "user" && role !== "assistant" && role !== "system" && role !== "tool") {
      role = "user";
    }
    messages.push({ role: role as OpenAIMessage["role"], content: textFromAnthropicContent(content) });
  }

  if (pendingToolIds.length) flushToolReplies(new Map());

  const out: OpenAIBody = {
    model: typeof body.model === "string" ? body.model : undefined,
    messages,
    stream: Boolean(body.stream),
  };
  const tools = anthropicToolsToOai(body.tools);
  if (tools) {
    out.tools = tools;
    const choice = anthropicToolChoiceToOai(body.tool_choice);
    if (choice !== null) out.tool_choice = choice;
  }
  const mt = body.max_tokens;
  if (typeof mt === "number" && mt > 0) out.max_tokens = mt;
  const temp = body.temperature;
  if (typeof temp === "number") out.temperature = temp;
  return out;
}
