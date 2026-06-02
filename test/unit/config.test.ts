/** Unit tests for config loading, normalization and validation. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { normalizeModels, stripJsonc, stripUnderscoreKeys, parseConfigText, slug, inferType, wrapAuth, REPO_ROOT } from "../../src/config/config.js";
import { validateConfig } from "../../src/config/validate.js";
import type { Config } from "../../src/config/types.js";

test("normalizeModels: model-only entries infer id, type and auth", () => {
  const { slotMap, discoveryModels } = normalizeModels([
    { model: "deepseek-v4-pro", url: "https://api.deepseek.com/anthropic", key: "sk-x" },
    { model: "MiniMax-M3", url: "https://api.minimax.io/v1", key: "sk-y" },
    { model: "claude-opus-4-8" },
    { model: "gpt-5.5", api: "codex" },
  ]);
  assert.ok(slotMap["claude-deepseek-v4-pro"], "deepseek id");
  assert.ok(slotMap["claude-minimax-m3"], "minimax id");
  assert.ok(slotMap["claude-opus-4-8"], "opus id without doubled prefix");
  assert.ok(slotMap["claude-gpt-5-5"], "gpt id");
  assert.equal(slotMap["claude-deepseek-v4-pro"]!.type, undefined, "/anthropic = passthrough");
  assert.equal(slotMap["claude-minimax-m3"]!.type, "openai_compat");
  assert.equal(slotMap["claude-opus-4-8"]!.type, undefined);
  assert.equal(slotMap["claude-gpt-5-5"]!.type, "codex_oauth");
  assert.equal(slotMap["claude-minimax-m3"]!.model, "MiniMax-M3", "backend id preserved (case intact)");
  assert.equal(slotMap["claude-gpt-5-5"]!.model, "gpt-5.5");
  assert.equal(slotMap["claude-deepseek-v4-pro"]!.auth, "Bearer sk-x");
  assert.equal(slotMap["claude-opus-4-8"]!.auth, undefined, "no key => passthrough credential");
  assert.equal(slotMap["claude-deepseek-v4-pro"]!.upstream, "https://api.deepseek.com/anthropic");
  assert.equal(discoveryModels.length, 4, "one entry → one advertised model");
});

test("[1m] suffix on model → 1M discovery id, force1m slot, clean backend id", () => {
  const { slotMap, discoveryModels } = normalizeModels([
    { model: "MiniMax-M3[1m]", url: "https://x/v1", key: "k" },
    { model: "deepseek-v4-pro", url: "https://api.deepseek.com/anthropic", key: "k" },
  ]);
  assert.ok(slotMap["claude-minimax-m3"], "slot keyed by base id (sans [1m])");
  assert.equal(slotMap["claude-minimax-m3"]!.force1m, true);
  assert.equal(slotMap["claude-minimax-m3"]!.model, "MiniMax-M3", "suffix stripped off the backend id");
  assert.equal(slotMap["claude-deepseek-v4-pro"]!.force1m, undefined);
  const m1 = discoveryModels.find((m) => m.id === "claude-minimax-m3[1m]");
  assert.ok(m1, "[1m] id advertised");
  assert.equal(m1!.context_window, 1_000_000);
  assert.ok(!discoveryModels.some((m) => m.id === "claude-minimax-m3"), "bare id NOT advertised for a [1m] entry");
  assert.equal(discoveryModels.find((m) => m.id === "claude-deepseek-v4-pro")!.context_window, 200_000);
});

test("normalizeModels: display name defaults to model, override via name", () => {
  const { discoveryModels } = normalizeModels([{ model: "MiniMax-M3[1m]" }, { model: "x", name: "Pretty Name" }]);
  assert.equal(discoveryModels.find((m) => m.id === "claude-minimax-m3[1m]")!.display_name, "MiniMax-M3[1m]");
  assert.equal(discoveryModels.find((m) => m.id === "claude-x")!.display_name, "Pretty Name");
});

test("normalizeModels dedups colliding ids and skips entries with no model", () => {
  const { discoveryModels } = normalizeModels([
    { model: "x", url: "https://a/v1", key: "k" },
    { model: "x", url: "https://b/v1", key: "k" },
    { url: "https://c/v1" } as any,
    { model: "   " },
  ]);
  assert.deepEqual(discoveryModels.map((m) => m.id), ["claude-x", "claude-x-2"]);
});

test("normalizeModels expands ${ENV} in url/key/model/headers/workspace", () => {
  process.env.T_URL = "https://env-host/v1";
  process.env.T_KEY = "env-secret";
  const { slotMap } = normalizeModels([
    { model: "m", url: "${T_URL}", key: "${T_KEY}", headers: { "X-H": "${T_KEY}" } },
  ]);
  const s = slotMap["claude-m"]!;
  assert.equal(s.upstream, "https://env-host/v1");
  assert.equal(s.auth, "Bearer env-secret");
  assert.equal(s.headers!["X-H"], "env-secret");
});

test("config helpers (slug/inferType/wrapAuth)", () => {
  assert.equal(slug("DeepSeek V4 Pro"), "deepseek-v4-pro");
  assert.equal(slug("GPT-5.5"), "gpt-5-5");
  assert.equal(slug("!!!"), "model", "empty slug falls back");
  assert.equal(inferType("https://x/anthropic", undefined), "anthropic");
  assert.equal(inferType("https://x/v1", undefined), "openai_compat");
  assert.equal(inferType(undefined, undefined), "anthropic");
  assert.equal(inferType("https://x/v1", "anthropic"), "anthropic", "explicit api wins");
  assert.equal(inferType(undefined, "codex"), "codex_oauth");
  assert.equal(inferType(undefined, "cursor"), "cursor_agent");
  assert.equal(wrapAuth("sk-x"), "Bearer sk-x");
  assert.equal(wrapAuth("Bearer sk-x"), "Bearer sk-x", "already-Bearer passes through");
  assert.equal(wrapAuth("x-api-key: sk-x"), "x-api-key: sk-x");
  assert.equal(wrapAuth("  "), undefined);
  assert.equal(wrapAuth(undefined), undefined);
});

test("stripJsonc removes comments and trailing commas but not string contents", () => {
  const obj = JSON.parse(stripJsonc(`{
    // line comment
    "url": "http://x/y", /* block */
    "note": "a // b /* c */ d,}",
    "arr": [1, 2,],
    "nested": { "ok": true, },
  }`));
  assert.equal(obj.url, "http://x/y");
  assert.equal(obj.note, "a // b /* c */ d,}");
  assert.deepEqual(obj.arr, [1, 2]);
  assert.deepEqual(obj.nested, { ok: true });
});

test("stripUnderscoreKeys drops _-prefixed doc keys recursively", () => {
  const out = stripUnderscoreKeys({ _doc: "x", model: "m", nested: { _n: 1, keep: 2 }, arr: [{ _a: 1, b: 2 }] }) as any;
  assert.deepEqual(out, { model: "m", nested: { keep: 2 }, arr: [{ b: 2 }] });
});

test("parseConfigText strips JSONC + underscore keys together", () => {
  const cfg = parseConfigText(`{ // hi\n "_note": "x", "port": 9000, "models": [], }`);
  assert.equal((cfg as any)._note, undefined);
  assert.equal(cfg.port, 9000);
});

test("REPO_ROOT resolves to the repo root, not dist/", () => {
  assert.ok(existsSync(join(REPO_ROOT, "package.json")), "package.json should exist at REPO_ROOT");
  assert.ok(!/[\\/]dist$/.test(REPO_ROOT), "REPO_ROOT must not be the dist/ folder");
});

test("validateConfig requires model, flags unknown api / missing openai url / force_1m", () => {
  const r = validateConfig({ force_1m: true, models: [{} as any, { model: "a", api: "openai" }, { model: "b", api: "bogus" } as any] } as Config);
  assert.ok(r.errors.some((e) => e.includes("missing a string 'model'")), "entry without model errors");
  assert.ok(r.errors.some((e) => e.includes("'a'") && e.includes("url")), "openai without url errors");
  assert.ok(r.errors.some((e) => e.includes("unknown api")), "bad api errors");
  assert.ok(r.warnings.some((w) => w.includes("force_1m")), "force_1m warned");
});

test("validateConfig accepts codex/cursor without url (login-based)", () => {
  const r = validateConfig({ models: [{ model: "gpt-5.5", api: "codex" }, { model: "composer-2.5", api: "cursor" }] } as Config);
  assert.equal(r.errors.length, 0, "no url required for codex/cursor");
});

test("validateConfig warns on placeholder keys, duplicates, and bad port", () => {
  const r = validateConfig({ port: 70000, models: [{ model: "x", url: "https://a/v1", key: "YOUR_KEY" }, { model: "x", url: "https://a/v1", key: "k" }] } as Config);
  assert.ok(r.warnings.some((w) => w.includes("placeholder")), "placeholder key warned");
  assert.ok(r.warnings.some((w) => w.includes("duplicate")), "duplicate model warned");
  assert.ok(r.errors.some((e) => e.includes("port")), "out-of-range port errors");
});

test("validateConfig does NOT flag a ${ENV} key as a placeholder", () => {
  const r = validateConfig({ models: [{ model: "x", url: "https://a/v1", key: "${YOUR_KEY}" }] } as Config);
  assert.ok(!r.warnings.some((w) => w.includes("placeholder")), "an env-ref key is fine");
});
