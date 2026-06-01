/**
 * Empty-turn resilience. Some upstreams occasionally return a turn with NO text
 * and NO tool call (a transient hiccup, or a budget-exhausted reasoning turn at
 * high effort — notably GPT-5.5 via codex). An empty assistant turn is useless,
 * so we transparently retry a fresh turn a bounded number of times. Streaming is
 * preserved: events are buffered only until the first meaningful event, so a
 * normal turn has zero added latency and partial output is never duplicated.
 */
import type { EventFactory, InternalEvent } from "./types.js";
import { ENV } from "./env.js";
import { log, vlog } from "./log.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Transient failures worth retrying; fatal (4xx auth/validation) are not. */
export function retryableStatus(status: number | undefined | null): boolean {
  if (status === undefined || status === null) return true;
  const s = Number(status);
  if (!Number.isFinite(s)) return true;
  return s === 0 || s >= 500 || s === 408 || s === 409 || s === 425 || s === 429;
}

export async function* eventsWithRetry(
  makeEvents: EventFactory,
  label = "upstream",
  attempts = ENV.EMPTY_RETRY_ATTEMPTS,
  backoff = ENV.EMPTY_RETRY_BACKOFF,
): AsyncGenerator<InternalEvent> {
  let lastBuffer: InternalEvent[] = [];
  for (let attempt = 0; attempt <= attempts; attempt++) {
    let buffer: InternalEvent[] = [];
    let meaningful = false;
    let fatal: InternalEvent | null = null;
    try {
      for await (const ev of makeEvents()) {
        if (meaningful) {
          yield ev;
          continue;
        }
        if ((ev.type === "text_delta" && ev.text.trim()) || ev.type === "tool_call") {
          meaningful = true;
          for (const b of buffer) yield b;
          buffer = [];
          yield ev;
          continue;
        }
        if (ev.type === "error" && !retryableStatus(ev.status)) fatal = ev;
        buffer.push(ev);
      }
    } catch (e) {
      vlog(`${label} stream error (attempt ${attempt + 1}): ${String(e)}`);
    }
    if (meaningful) return;
    if (fatal) {
      for (const b of buffer) yield b;
      return;
    }
    lastBuffer = buffer;
    if (attempt < attempts) {
      log(`${label}: empty turn, retrying (${attempt + 1}/${attempts})`);
      await sleep(backoff * (attempt + 1) * 1000);
      continue;
    }
    for (const b of lastBuffer) yield b;
    return;
  }
}
