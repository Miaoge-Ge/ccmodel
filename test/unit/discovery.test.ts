/** Unit tests for /v1/models discovery merging. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeModels } from "../../src/config/config.js";
import { mergeModelsResponse } from "../../src/pipeline/models.js";

test("mergeModelsResponse appends custom models, never duplicating ids", () => {
  const { discoveryModels } = normalizeModels([{ model: "claude-opus-4-8" }, { model: "MiniMax-M3[1m]", url: "https://x/v1", key: "k" }]);
  const merged = mergeModelsResponse({ data: [{ id: "claude-opus-4-8", type: "model" }] }, discoveryModels);
  const ids = (merged.data as Array<{ id: string }>).map((m) => m.id);
  assert.deepEqual(ids, ["claude-opus-4-8", "claude-minimax-m3[1m]"], "existing id kept once, custom appended");
});

test("mergeModelsResponse tolerates a non-object upstream by starting from a skeleton", () => {
  const { discoveryModels } = normalizeModels([{ model: "a" }, { model: "b" }]);
  for (const upstream of [null, undefined, "garbage", 42]) {
    const fresh = mergeModelsResponse(upstream, discoveryModels);
    assert.equal((fresh.data as unknown[]).length, 2);
    assert.equal(fresh.has_more, false);
  }
});

test("mergeModelsResponse preserves an upstream model not in the custom list", () => {
  const merged = mergeModelsResponse({ data: [{ id: "claude-sonnet-4-6", type: "model" }] }, []);
  assert.deepEqual(
    (merged.data as Array<{ id: string }>).map((m) => m.id),
    ["claude-sonnet-4-6"],
  );
});
