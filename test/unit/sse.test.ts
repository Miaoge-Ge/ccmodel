/** Unit tests for the OpenAI→internal-event parser and SSE helpers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sseFrame, stopReasonFor, parseToolInput, oaiResponseToEvents } from "../../src/net/sse.js";
import type { UpstreamResponse } from "../../src/net/http.js";
import type { InternalEvent } from "../../src/config/types.js";

function fakeResp(contentType: string, chunks: string[]): UpstreamResponse {
  return {
    status: 200,
    headers: {},
    contentType,
    raw: null as any,
    async *chunks() {
      for (const c of chunks) yield Buffer.from(c, "utf-8");
    },
    async text() {
      return chunks.join("");
    },
  };
}

async function collect(gen: AsyncGenerator<InternalEvent>): Promise<InternalEvent[]> {
  const out: InternalEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

test("sseFrame formats an event + data line", () => {
  assert.equal(sseFrame("ping", { a: 1 }), 'event: ping\ndata: {"a":1}\n\n');
});

test("stopReasonFor maps OpenAI finish reasons", () => {
  assert.equal(stopReasonFor("tool_calls"), "tool_use");
  assert.equal(stopReasonFor("length"), "max_tokens");
  assert.equal(stopReasonFor("stop"), "end_turn");
  assert.equal(stopReasonFor(undefined), "end_turn");
});

test("parseToolInput parses JSON, falls back to {input} on garbage", () => {
  assert.deepEqual(parseToolInput('{"a":1}'), { a: 1 });
  assert.deepEqual(parseToolInput("not json"), { input: "not json" });
  assert.deepEqual(parseToolInput(undefined), {});
});

test("oaiResponseToEvents: SSE stream → text deltas, assembled tool call, usage", async () => {
  const events = await collect(
    oaiResponseToEvents(
      fakeResp("text/event-stream", [
        'data: {"choices":[{"delta":{"content":"He"}}]}\n',
        'data: {"choices":[{"delta":{"content":"llo"}}]}\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"f","arguments":"{\\"x\\":"}}]}}]}\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n',
        "data: [DONE]\n",
      ]),
    ),
  );
  const text = events
    .filter((e) => e.type === "text_delta")
    .map((e: any) => e.text)
    .join("");
  assert.equal(text, "Hello");
  const tc = events.find((e) => e.type === "tool_call") as any;
  assert.equal(tc.name, "f");
  assert.equal(tc.arguments, '{"x":1}', "fragmented arguments reassembled across deltas");
  const usage = events.find((e) => e.type === "usage") as any;
  assert.deepEqual([usage.input_tokens, usage.output_tokens], [5, 2]);
});

test("oaiResponseToEvents: plain JSON response → text + tool call + usage", async () => {
  const events = await collect(
    oaiResponseToEvents(
      fakeResp("application/json", [
        JSON.stringify({
          choices: [
            {
              message: { content: "hi", tool_calls: [{ id: "c1", function: { name: "g", arguments: '{"a":1}' } }] },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        }),
      ]),
    ),
  );
  assert.equal((events.find((e) => e.type === "text_delta") as any).text, "hi");
  assert.equal((events.find((e) => e.type === "tool_call") as any).name, "g");
  assert.equal((events.find((e) => e.type === "usage") as any).input_tokens, 7);
});

test("oaiResponseToEvents: malformed JSON body yields an error event", async () => {
  const events = await collect(oaiResponseToEvents(fakeResp("application/json", ["{not json"])));
  assert.equal(events[0]!.type, "error");
});
