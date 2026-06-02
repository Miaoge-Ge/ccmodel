#!/usr/bin/env node
/**
 * ccmodel — entry point.
 *
 * Gives Claude Code's UltraCode behavior (and a reliable `[1m]` 1M context) to
 * ANY model, and lets you pick those models from the /model menu. Point Claude
 * Code's ANTHROPIC_BASE_URL at this proxy (the launchers do it for you).
 *
 * Usage:
 *   node dist/src/main.js              start the proxy
 *   node dist/src/main.js --models     print the advertised model list as JSON
 *                                      (id + display_name, incl. [1m] variants)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ENV } from "./core/env.js";
import { loadConfig, defaultConfigPath, normalizeModels } from "./config/config.js";
import { validateConfig } from "./config/validate.js";
import { createServer, type ProxyContext } from "./server.js";
import type { EnvelopeSettings } from "./pipeline/envelope.js";
import type { Config } from "./config/types.js";
import { log } from "./core/log.js";

/** Bumped on releases; surfaced in /healthz. */
const VERSION = "1.2.0";

function resolveContext(): { ctx: ProxyContext; host: string; port: number } {
  const cfgPath = process.env.UC_CONFIG || defaultConfigPath();
  let cfg: Config = {};
  try {
    cfg = loadConfig(cfgPath);
    log(`config: ${cfgPath}`);
    if (/config\.example\./.test(cfgPath)) {
      log("WARNING: using config.example.* (placeholders) — copy it to config.jsonc and add your own keys");
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      log(`config not found (${cfgPath}); copy config.example.jsonc to config.jsonc`);
    } else {
      log(`config parse failed (${cfgPath}): ${String(e)} — continuing with defaults`);
    }
  }

  // Surface config problems loudly at startup (the proxy still serves whatever
  // is valid). The doctor does a deeper, credential-aware check.
  const { errors, warnings } = validateConfig(cfg);
  for (const w of warnings) log(`config warning: ${w}`);
  for (const e of errors) log(`config error: ${e}`);

  // Precedence: explicit env var > config > built-in default.
  const host = process.env.UC_LISTEN_HOST || cfg.host || ENV.LISTEN_HOST;
  const port = "UC_LISTEN_PORT" in process.env ? ENV.LISTEN_PORT : cfg.port ? Number(cfg.port) : ENV.LISTEN_PORT;
  const upstream = ("UC_UPSTREAM" in process.env ? ENV.UPSTREAM : cfg.upstream || ENV.UPSTREAM).replace(/\/+$/, "");
  const maxTokensFloor =
    "UC_MAX_TOKENS" in process.env ? ENV.MAX_TOKENS_FLOOR : cfg.max_tokens ? Number(cfg.max_tokens) : ENV.MAX_TOKENS_FLOOR;

  const settings: EnvelopeSettings = {
    forceEffort: ENV.FORCE_EFFORT,
    forceThinking: ENV.FORCE_THINKING,
    maxTokensFloor,
    injectReminder: ENV.INJECT_REMINDER,
    force1m: ENV.FORCE_1M || cfg.force_1m === true,
  };

  // Each entry becomes one routing slot + one advertised model. A `[1m]` suffix
  // on the entry's `model` makes that advertised pick a guaranteed-1M model.
  const { slotMap, discoveryModels } = normalizeModels(cfg.models);

  const ctx: ProxyContext = {
    upstream,
    settings,
    slotMap,
    modelMap: ENV.MODEL_MAP,
    discoveryModels,
    version: VERSION,
  };
  return { ctx, host, port };
}

function printModels(): void {
  const { ctx } = resolveContext();
  process.stdout.write(JSON.stringify(ctx.discoveryModels.map((m) => ({ id: m.id, display_name: m.display_name }))) + "\n");
}

/**
 * Write Claude Code's gateway-models cache so the user's models (incl. [1m]
 * variants) appear in /model on the very first open. Used by the launchers.
 */
function seedCache(cacheFile: string, baseUrl: string): void {
  const { ctx } = resolveContext();
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(
    cacheFile,
    JSON.stringify({
      baseUrl,
      fetchedAt: Date.now(),
      models: ctx.discoveryModels.map((m) => ({ id: m.id, display_name: m.display_name })),
    }),
    "utf-8",
  );
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes("--models") || argv.includes("--print-models")) {
    printModels();
    return;
  }
  const seedIdx = argv.indexOf("--seed-cache");
  if (seedIdx !== -1) {
    const file = argv[seedIdx + 1];
    const base = argv[seedIdx + 2];
    if (!file || !base) {
      process.stderr.write("usage: --seed-cache <cacheFile> <baseUrl>\n");
      process.exit(2);
    }
    seedCache(file, base);
    return;
  }

  const { ctx, host, port } = resolveContext();

  if (ctx.discoveryModels.length) {
    log(`  advertising ${ctx.discoveryModels.length} model(s) on GET /v1/models:`);
    for (const m of ctx.discoveryModels) log(`    ${m.id}  (${m.display_name})`);
  } else {
    log("  no models configured (GET /v1/models passes through unchanged)");
  }
  for (const [mid, slot] of Object.entries(ctx.slotMap)) {
    log(`  route ${mid} -> type=${slot.type || "anthropic"} model=${slot.model || mid} upstream=${slot.upstream || "(default)"}`);
  }

  const server = createServer(ctx);
  server.listen(port, host, () => {
    log(`ccmodel listening on http://${host}:${port} -> ${ctx.upstream}`);
    log(
      `effort=${ctx.settings.forceEffort} thinking=${ctx.settings.forceThinking} ` +
        `max_tokens_floor=${ctx.settings.maxTokensFloor} inject_reminder=${ctx.settings.injectReminder} ` +
        `force_1m=${ctx.settings.force1m}`,
    );
  });

  const shutdown = (): void => {
    log("shutting down");
    server.close(() => process.exit(0));
    // Force-exit if connections linger.
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
