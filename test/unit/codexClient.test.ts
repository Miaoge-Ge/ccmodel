/** Unit tests for the Codex (GPT-5.5 via login) helper: request shaping + SSE parsing. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  messagesToResponsesInput,
  toolsToResponses,
  toolChoiceToResponses,
  parseCodexResponsesStream,
  decodeJwtClaims,
  accountId,
  isExpiring,
} from "../../src/providers/codexClient.js";
import type { InternalEvent, OpenAIMessage } from "../../src/config/types.js";

/** Build an unsigned JWT (header.payload.sig) with the given claims, base64url. */
function jwt(claims: Record<string, unknown>): string {
  const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64u({ alg: "none" })}.${b64u(claims)}.sig`;
}

async function collect(gen: AsyncGenerator<InternalEvent>): Promise<InternalEvent[]> {
  const out: InternalEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** Yield each string as a Buffer chunk (mimicking an SSE byte stream). */
async function* chunks(...lines: string[]): AsyncGenerator<Buffer> {
  for (const l of lines) yield Buffer.from(l, "utf-8");
}

test("decodeJwtClaims / accountId / isExpiring read the token payload", () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const token = jwt({ exp: future, "https://api.openai.com/auth": { chatgpt_account_id: "acc_42" } });
  assert.equal((decodeJwtClaims(token) as any).exp, future);
  assert.equal(accountId(token), "acc_42");
  assert.equal(isExpiring(token), false, "an hour out is not expiring");

  const stale = jwt({ exp: Math.floor(Date.now() / 1000) - 10 });
  assert.equal(isExpiring(stale), true);
  assert.equal(accountId(jwt({})), undefined, "no account claim → undefined");
  assert.deepEqual(decodeJwtClaims("garbage"), {}, "malformed token → empty claims");
  assert.equal(isExpiring(jwt({})), false, "no exp claim → treated as not expiring");
});

test("messagesToResponsesInput maps roles to Responses items + instructions", () => {
  const msgs: OpenAIMessage[] = [
    { role: "system", content: "be terse" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "thinking", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } }] },
    { role: "tool", tool_call_id: "c1", content: "result" },
  ];
  const { instructions, items } = messagesToResponsesInput(msgs);
  assert.equal(instructions, "be terse");
  assert.equal(items[0]!.type, "message"); // user
  assert.equal((items[0] as any).role, "user");
  assert.equal(items[1]!.type, "message"); // assistant text
  assert.equal(items[2]!.type, "function_call");
  assert.equal((items[2] as any).call_id, "c1");
  assert.equal(items[3]!.type, "function_call_output");
  assert.equal((items[3] as any).output, "result");
});

test("toolsToResponses converts OpenAI tool defs; toolChoiceToResponses normalizes", () => {
  const tools = toolsToResponses([
    { type: "function", function: { name: "g", description: "d", parameters: { type: "object" } } },
    { junk: true },
  ]);
  assert.equal(tools.length, 1);
  assert.equal((tools[0] as any).name, "g");
  assert.equal((tools[0] as any).type, "function");
  assert.equal(toolChoiceToResponses("required"), "required");
  assert.deepEqual(toolChoiceToResponses({ type: "function", function: { name: "g" } }), { type: "function", name: "g" });
  assert.equal(toolChoiceToResponses({ nonsense: 1 }), "auto");
});

test("parseCodexResponsesStream: text deltas + usage", async () => {
  const events = await collect(
    parseCodexResponsesStream(
      chunks(
        'data: {"type":"response.output_text.delta","delta":"Hel"}\n',
        'data: {"type":"response.output_text.delta","delta":"lo"}\n',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":2}}}\n',
        "data: [DONE]\n",
      ),
    ),
  );
  assert.equal(
    events
      .filter((e) => e.type === "text_delta")
      .map((e: any) => e.text)
      .join(""),
    "Hello",
  );
  const usage = events.find((e) => e.type === "usage") as any;
  assert.deepEqual([usage.input_tokens, usage.output_tokens], [4, 2]);
});

test("parseCodexResponsesStream: function call assembled across added/delta/done", async () => {
  const events = await collect(
    parseCodexResponsesStream(
      chunks(
        'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_9","id":"item_9","name":"weather","arguments":""}}\n',
        'data: {"type":"response.function_call_arguments.delta","item_id":"item_9","delta":"{\\"city\\":"}\n',
        'data: {"type":"response.function_call_arguments.delta","call_id":"call_9","delta":"\\"NYC\\"}"}\n',
        'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_9","id":"item_9","name":"weather"}}\n',
        "data: [DONE]\n",
      ),
    ),
  );
  const tc = events.find((e) => e.type === "tool_call") as any;
  assert.equal(tc.name, "weather");
  assert.equal(tc.arguments, '{"city":"NYC"}', "args reassembled via call_id/item_id aliasing");
});

test("parseCodexResponsesStream: a never-`done` tool call is still flushed", async () => {
  const events = await collect(
    parseCodexResponsesStream(
      chunks(
        'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"c","name":"f","arguments":"{}"}}\n',
        "data: [DONE]\n",
      ),
    ),
  );
  assert.equal((events.find((e) => e.type === "tool_call") as any).name, "f");
});

test("parseCodexResponsesStream: error frame surfaces an error event", async () => {
  const events = await collect(
    parseCodexResponsesStream(chunks('data: {"type":"response.failed","error":{"message":"nope"}}\n', "data: [DONE]\n")),
  );
  assert.equal((events.find((e) => e.type === "error") as any).message, "nope");
});
