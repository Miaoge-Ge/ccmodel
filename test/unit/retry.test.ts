/** Unit tests for empty-turn retry + the retryable-status policy. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { retryableStatus, eventsWithRetry } from "../../src/pipeline/retry.js";
import type { EventFactory, InternalEvent } from "../../src/config/types.js";

async function collect(gen: AsyncGenerator<InternalEvent>): Promise<InternalEvent[]> {
  const out: InternalEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const factory = (...turns: InternalEvent[][]): { make: EventFactory; calls: () => number } => {
  let i = 0;
  return {
    calls: () => i,
    make: () => {
      const turn = turns[Math.min(i, turns.length - 1)]!;
      i += 1;
      return (async function* () {
        for (const e of turn) yield e;
      })();
    },
  };
};

test("retryableStatus: transient vs fatal", () => {
  for (const s of [undefined, null, 0, 500, 502, 408, 409, 425, 429]) assert.equal(retryableStatus(s as any), true, `${s} retryable`);
  for (const s of [400, 401, 403, 404, 422]) assert.equal(retryableStatus(s), false, `${s} fatal`);
});

test("a meaningful first turn streams through with no retry", async () => {
  const f = factory([{ type: "text_delta", text: "hello" }]);
  const out = await collect(eventsWithRetry(f.make, "t", 2, 0));
  assert.equal(f.calls(), 1, "no retry");
  assert.equal((out[0] as any).text, "hello");
});

test("an empty turn is retried, and the recovered turn is emitted", async () => {
  const f = factory([{ type: "usage", output_tokens: 0 }], [{ type: "text_delta", text: "recovered" }]);
  const out = await collect(eventsWithRetry(f.make, "t", 2, 0));
  assert.equal(f.calls(), 2, "retried exactly once");
  assert.ok(out.some((e) => e.type === "text_delta" && e.text === "recovered"));
});

test("a fatal error is NOT retried and is surfaced", async () => {
  const f = factory([{ type: "error", message: "bad key", status: 401 }]);
  const out = await collect(eventsWithRetry(f.make, "t", 2, 0));
  assert.equal(f.calls(), 1, "fatal → no retry");
  assert.equal((out[0] as any).message, "bad key");
});

test("after exhausting attempts the last buffer is flushed", async () => {
  const f = factory([{ type: "usage", output_tokens: 0 }]); // always empty
  const out = await collect(eventsWithRetry(f.make, "t", 2, 0));
  assert.equal(f.calls(), 3, "initial + 2 retries");
  assert.ok(out.some((e) => e.type === "usage"));
});
