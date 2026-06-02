/** Unit tests for the Anthropic SSE + JSON emitters. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { streamAnthropicFromEvents, jsonAnthropicFromEvents } from "../../src/net/emit.js";
import type { InternalEvent } from "../../src/config/types.js";

/** A ServerResponse stand-in that just records what was written. */
function fakeRes() {
  const chunks: string[] = [];
  const res = {
    statusCode: 0,
    headersSent: false,
    headers: {} as Record<string, unknown>,
    ended: false,
    writeHead(status: number, headers?: Record<string, unknown>) {
      this.statusCode = status;
      if (headers) this.headers = headers;
      this.headersSent = true;
      return this;
    },
    write(c: string | Buffer) {
      chunks.push(typeof c === "string" ? c : c.toString("utf-8"));
      return true;
    },
    end(c?: string | Buffer) {
      if (c) chunks.push(typeof c === "string" ? c : c.toString("utf-8"));
      this.ended = true;
    },
    get body() {
      return chunks.join("");
    },
  };
  return res;
}

async function* gen(...events: InternalEvent[]): AsyncGenerator<InternalEvent> {
  for (const e of events) yield e;
}

test("stream: text deltas → a well-formed Anthropic SSE message", async () => {
  const res = fakeRes();
  await streamAnthropicFromEvents(
    res as unknown as ServerResponse,
    gen({ type: "text_delta", text: "Hi " }, { type: "text_delta", text: "there" }, { type: "usage", output_tokens: 7 }),
    "claude-x",
  );
  const b = res.body;
  assert.equal(res.headers["Content-Type"], "text/event-stream");
  assert.ok(b.includes("event: message_start"));
  assert.ok(b.includes('"type":"content_block_start"') && b.includes('"type":"text"'));
  assert.ok(b.includes('"text_delta"') && b.includes("Hi ") && b.includes("there"));
  assert.ok(b.includes('"stop_reason":"end_turn"'));
  assert.ok(b.includes('"output_tokens":7'));
  assert.ok(b.includes("event: message_stop"));
  assert.ok(res.ended);
});

test("stream: a tool_call closes any open text and emits tool_use + input_json_delta", async () => {
  const res = fakeRes();
  await streamAnthropicFromEvents(
    res as unknown as ServerResponse,
    gen({ type: "text_delta", text: "thinking" }, { type: "tool_call", id: "toolu_1", name: "get_weather", arguments: '{"city":"Paris"}' }),
    "claude-x",
  );
  const b = res.body;
  assert.ok(b.includes('"type":"tool_use"') && b.includes('"name":"get_weather"'));
  assert.ok(b.includes('"input_json_delta"') && b.includes("Paris"));
  assert.ok(b.includes('"stop_reason":"tool_use"'));
});

test("stream: an error before any output is surfaced as visible text", async () => {
  const res = fakeRes();
  await streamAnthropicFromEvents(
    res as unknown as ServerResponse,
    gen({ type: "error", message: "upstream boom", status: 502 }),
    "claude-x",
  );
  assert.ok(res.body.includes("[ccmodel] upstream boom"));
});

test("stream: no events still produces an (empty) well-formed message", async () => {
  const res = fakeRes();
  await streamAnthropicFromEvents(res as unknown as ServerResponse, gen(), "claude-x");
  const b = res.body;
  assert.ok(b.includes("event: message_start") && b.includes("event: message_stop"));
  assert.ok(b.includes('"stop_reason":"end_turn"'));
});

test("json: text + tool_call → one Anthropic message with both blocks", async () => {
  const res = fakeRes();
  let errCalled = false;
  await jsonAnthropicFromEvents(
    res as unknown as ServerResponse,
    gen(
      { type: "text_delta", text: "hi" },
      { type: "tool_call", id: "toolu_2", name: "f", arguments: '{"a":1}' },
      { type: "usage", input_tokens: 5, output_tokens: 3 },
    ),
    "claude-x",
    () => {
      errCalled = true;
    },
  );
  assert.equal(errCalled, false);
  const msg = JSON.parse(res.body);
  assert.equal(msg.type, "message");
  assert.equal(msg.content[0].type, "text");
  assert.equal(msg.content[0].text, "hi");
  assert.equal(msg.content[1].type, "tool_use");
  assert.deepEqual(msg.content[1].input, { a: 1 });
  assert.equal(msg.stop_reason, "tool_use");
  assert.deepEqual([msg.usage.input_tokens, msg.usage.output_tokens], [5, 3]);
});

test("json: an error with no content invokes sendError, not a 200 body", async () => {
  const res = fakeRes();
  let captured: { status: number; message: string } | null = null;
  await jsonAnthropicFromEvents(
    res as unknown as ServerResponse,
    gen({ type: "error", message: "bad key", status: 401 }),
    "claude-x",
    (status, message) => {
      captured = { status, message };
    },
  );
  assert.deepEqual(captured, { status: 401, message: "bad key" });
  assert.equal(res.ended, false, "no 200 body written when erroring");
});

test("json: no content yields a single empty text block", async () => {
  const res = fakeRes();
  await jsonAnthropicFromEvents(res as unknown as ServerResponse, gen(), "claude-x", () => {});
  const msg = JSON.parse(res.body);
  assert.equal(msg.content.length, 1);
  assert.equal(msg.content[0].text, "");
  assert.equal(msg.stop_reason, "end_turn");
});
