/** Unit tests for the UltraCode envelope + [1m] routing transform. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeModels } from "../../src/config/config.js";
import { transformMessagesBody } from "../../src/pipeline/envelope.js";
import { CONTEXT_1M_BETA } from "../../src/pipeline/model1m.js";
import { SETTINGS, msg } from "../helpers/harness.js";

test("transformMessagesBody strips [1m], sets the envelope, flags want1m via suffix", () => {
  const { slotMap } = normalizeModels([{ model: "backend-x", api: "anthropic", url: "https://up" }]);
  const { body, route } = transformMessagesBody(msg("claude-backend-x[1m]"), {}, slotMap, {}, SETTINGS);
  const out = JSON.parse(body.toString());
  assert.equal(out.model, "backend-x", "suffix-free backend id sent upstream");
  assert.equal(out.output_config.effort, "xhigh");
  assert.equal(out.thinking.type, "adaptive");
  assert.ok(out.max_tokens >= 64000);
  assert.equal(route.want1m, true);
  assert.equal(route.upstream, "https://up");
});

test("a [1m] entry forces 1M even when the suffix was stripped on the wire", () => {
  const { slotMap } = normalizeModels([{ model: "backend[1m]", api: "anthropic", url: "https://up" }]);
  const r = transformMessagesBody(msg("claude-backend"), {}, slotMap, {}, SETTINGS);
  assert.equal(r.route.want1m, true, "force1m slot guarantees 1M regardless of the suffix");
});

test("a standard model stays 200K but still honors an explicit [1m] suffix", () => {
  const { slotMap } = normalizeModels([{ model: "backend", api: "anthropic", url: "https://up" }]);
  assert.equal(transformMessagesBody(msg("claude-backend"), {}, slotMap, {}, SETTINGS).route.want1m, false);
  assert.equal(transformMessagesBody(msg("claude-backend[1m]"), {}, slotMap, {}, SETTINGS).route.want1m, true);
});

test("global force_1m and an incoming 1M beta header each flag want1m", () => {
  const { slotMap } = normalizeModels([{ model: "backend", api: "anthropic", url: "https://up" }]);
  assert.equal(transformMessagesBody(msg("claude-backend"), {}, slotMap, {}, { ...SETTINGS, force1m: true }).route.want1m, true);
  assert.equal(transformMessagesBody(msg("claude-backend"), { "anthropic-beta": CONTEXT_1M_BETA }, slotMap, {}, SETTINGS).route.want1m, true);
});

test("per-model effort:false stops forcing effort (floor still applied)", () => {
  const { slotMap } = normalizeModels([{ model: "backend", api: "anthropic", url: "https://up", effort: false }]);
  const out = JSON.parse(transformMessagesBody(msg("claude-backend"), {}, slotMap, {}, SETTINGS).body.toString());
  assert.equal(out.output_config, undefined, "effort suppressed");
  assert.ok(out.max_tokens >= 64000, "max_tokens floor still applied");
});

test("per-model effort override sends a custom level", () => {
  const { slotMap } = normalizeModels([{ model: "backend", api: "anthropic", url: "https://up", effort: "medium" }]);
  const out = JSON.parse(transformMessagesBody(msg("claude-backend"), {}, slotMap, {}, SETTINGS).body.toString());
  assert.equal(out.output_config.effort, "medium");
});

test("an existing larger max_tokens is preserved (floor never lowers it)", () => {
  const { slotMap } = normalizeModels([{ model: "backend", api: "anthropic", url: "https://up" }]);
  const out = JSON.parse(transformMessagesBody(msg("claude-backend", { max_tokens: 99999 }), {}, slotMap, {}, SETTINGS).body.toString());
  assert.equal(out.max_tokens, 99999);
});

test("the Ultracode reminder is injected once, not duplicated", () => {
  const { slotMap } = normalizeModels([{ model: "backend", api: "anthropic", url: "https://up" }]);
  const out = JSON.parse(transformMessagesBody(msg("claude-backend"), {}, slotMap, {}, SETTINGS).body.toString());
  const sys = Array.isArray(out.system) ? out.system.map((b: any) => b.text).join("") : String(out.system);
  assert.ok(sys.includes("Ultracode is on:"));
  // a second pass over a body that already has the reminder must not add another
  const again = JSON.parse(transformMessagesBody(Buffer.from(JSON.stringify(out)), {}, slotMap, {}, SETTINGS).body.toString());
  const sys2 = Array.isArray(again.system) ? again.system.map((b: any) => b.text).join("") : String(again.system);
  assert.equal((sys2.match(/Ultracode is on:/g) || []).length, 1);
});

test("modelMap rewrites a bare id when no slot matches", () => {
  const out = JSON.parse(transformMessagesBody(msg("claude-x"), {}, {}, { "claude-x": "backend-y" }, SETTINGS).body.toString());
  assert.equal(out.model, "backend-y");
});

test("transformMessagesBody passes a malformed body through untouched", () => {
  const { body, route } = transformMessagesBody(Buffer.from("not json"), {}, {}, {}, SETTINGS);
  assert.equal(body.toString(), "not json");
  assert.deepEqual(route, {});
});

test("openai_compat slot carries its body/headers/cap onto the route", () => {
  const { slotMap } = normalizeModels([{ model: "m", url: "https://x/v1", key: "k", max_output_tokens: 1234, headers: { "X-H": "v" }, body: { reasoning_split: true } }]);
  const { route } = transformMessagesBody(msg("claude-m"), {}, slotMap, {}, SETTINGS);
  assert.equal(route.type, "openai_compat");
  assert.equal(route.max_output_tokens, 1234);
  assert.deepEqual(route.headers, { "X-H": "v" });
  assert.deepEqual(route.body, { reasoning_split: true });
});
