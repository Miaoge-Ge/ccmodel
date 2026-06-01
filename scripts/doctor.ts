#!/usr/bin/env node
/**
 * ccmodel doctor: verify the machine is ready, validate config, and run the
 * offline self-test. Exit code is non-zero if anything REQUIRED is missing, so
 * an AI or CI can gate on it. Each failure prints the one fix.
 *
 *   node dist/scripts/doctor.js            # full check
 *   node dist/scripts/doctor.js --no-test  # skip the self-test
 *   node dist/scripts/doctor.js --ci       # don't fail on a missing claude CLI
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { REPO_ROOT, parseConfigText } from "../src/config.js";
import { which } from "../src/which.js";
import { parseModelId } from "../src/model1m.js";
import type { Config, RouteConfig } from "../src/types.js";

const counts = { ok: 0, note: 0, fail: 0 };
const ok = (m: string) => (counts.ok++, console.log("[ok]  ", m));
const note = (m: string) => (counts.note++, console.log("[note]", m));
const fail = (m: string) => (counts.fail++, console.log("[FAIL]", m));

function loadEnvFile(p: string): void {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf-8").split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith("#") && t.includes("=")) {
      const i = t.indexOf("=");
      const k = t.slice(0, i).trim();
      if (!(k in process.env)) process.env[k] = t.slice(i + 1).trim();
    }
  }
}

function referencedVars(s: unknown): string[] {
  if (typeof s !== "string") return [];
  return [...s.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]!);
}
function looksLikePlaceholder(s: unknown): boolean {
  return typeof s === "string" && /REPLACE_WITH|your-|YOUR_/.test(s);
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: "127.0.0.1", port });
    sock.setTimeout(700);
    sock.on("connect", () => {
      sock.destroy();
      resolve(false); // something is listening
    });
    sock.on("timeout", () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(true)); // refused -> free
  });
}

async function main(): Promise<number> {
  const args = new Set(process.argv.slice(2));
  const noTest = args.has("--no-test");
  const ci = args.has("--ci");

  console.log("ccmodel doctor");
  console.log("repo:", REPO_ROOT);
  console.log();

  // 1. Node
  const major = Number(process.versions.node.split(".")[0]);
  major >= 18 ? ok(`node ${process.versions.node}`) : fail(`node >= 18 required; found ${process.versions.node}`);

  // 2. build output present
  const mainJs = join(REPO_ROOT, "dist", "src", "main.js");
  existsSync(mainJs) ? ok("build present (dist/src/main.js)") : fail("not built — run: npm run build");

  // 3. claude CLI
  const claude = which("claude");
  if (claude) ok(`claude CLI on PATH: ${claude}`);
  else if (ci) note("claude CLI not found (CI mode — skipping)");
  else fail("claude CLI not found — install: npm i -g @anthropic-ai/claude-code");

  // 4. config: load optional env, pick config file (fall back to the example)
  loadEnvFile(join(REPO_ROOT, "ccmodel.env"));
  let cfgPath = "";
  let usingExample = false;
  for (const name of ["config.jsonc", "config.json"]) {
    if (existsSync(join(REPO_ROOT, name))) {
      cfgPath = join(REPO_ROOT, name);
      break;
    }
  }
  if (!cfgPath) {
    for (const name of ["config.example.jsonc", "config.example.json"]) {
      if (existsSync(join(REPO_ROOT, name))) {
        cfgPath = join(REPO_ROOT, name);
        usingExample = true;
        break;
      }
    }
    if (cfgPath) note("no config.jsonc yet — validating the example (the launcher copies it on first run)");
  }

  let cfg: Config = {};
  try {
    cfg = parseConfigText(readFileSync(cfgPath, "utf-8"));
    ok(`config parses: ${cfgPath.split(/[\\/]/).pop()}`);
  } catch (e) {
    fail(`could not parse ${cfgPath || "config"}: ${String(e)}`);
  }

  const models = Array.isArray(cfg.models) ? cfg.models : [];
  const routes = cfg.routes && typeof cfg.routes === "object" ? cfg.routes : {};
  ok(`config has ${models.length} model(s) and ${Object.keys(routes).length} route(s)`);

  // 5. discovery rule: ids start with claude/anthropic and are routed
  let discoveryFails = 0;
  for (const m of models) {
    const mid = m?.id;
    if (!mid || !/^(claude|anthropic)/i.test(mid)) {
      fail(`model id '${mid}' will NOT appear in /model (must start with 'claude' or 'anthropic')`);
      discoveryFails++;
    }
    // A route may be keyed with the base id of a [1m] model; check the base.
    const base = parseModelId(mid).baseId;
    if (mid && !(mid in routes) && !(base in routes)) {
      fail(`model '${mid}' has no entry in routes — add a matching route`);
      discoveryFails++;
    }
  }
  if (models.length && discoveryFails === 0) ok("all advertised model ids are discoverable and routed");

  // 6. per-route backend checks
  for (const [name, route] of Object.entries(routes) as Array<[string, RouteConfig]>) {
    if (!route || typeof route !== "object") continue;
    const rtype = route.type || "anthropic";
    if (rtype === "codex_oauth") {
      const auth = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
      existsSync(auth)
        ? ok(`route '${name}': Codex login found (${auth})`)
        : note(`route '${name}': no ${auth} — run \`codex login\` before using it`);
      continue;
    }
    if (rtype === "cursor_agent") {
      const binp = process.env.CURSOR_AGENT_BIN || which("cursor-agent") || join(homedir(), ".local", "bin", "cursor-agent");
      binp && existsSync(binp)
        ? ok(`route '${name}': cursor-agent found (${binp})`)
        : note(`route '${name}': cursor-agent not found — install it and run \`cursor-agent login\` (experimental)`);
      continue;
    }
    // anthropic passthrough or openai_compat: validate the credential.
    const refs = new Set(referencedVars(route.auth));
    for (const hv of Object.values(route.headers || {})) for (const r of referencedVars(hv)) refs.add(r);
    for (const v of [...refs].sort()) {
      if (process.env[v]) ok(`route '${name}': env var ${v} is set`);
      else if (usingExample) note(`route '${name}': ${v} not set yet (example backend; set it once you keep this route)`);
      else fail(`route '${name}': ${v} is empty — export it or put the key inline in config`);
    }
    if (refs.size === 0 && looksLikePlaceholder(route.auth)) {
      usingExample
        ? note(`route '${name}': auth still has a placeholder (${route.auth}) — put your real key there`)
        : fail(`route '${name}': auth still has a placeholder — replace it with your real key`);
    }
  }

  // 7. port free
  const port = Number(process.env.UC_LISTEN_PORT) || cfg.proxy?.listen_port || 8141;
  (await portFree(port))
    ? ok(`port ${port} is free`)
    : note(`port ${port} already in use — a proxy may already be running (fine), or pick another`);

  // 8. offline self-test
  const testGlob = join(REPO_ROOT, "dist", "test");
  if (!noTest) {
    if (existsSync(join(testGlob, "proxy.test.js"))) {
      console.log("\nrunning offline self-test (node --test)...");
      const rc = spawnSync(process.execPath, ["--test", join(testGlob, "proxy.test.js")], { stdio: "inherit" }).status;
      rc === 0 ? ok("self-test passed") : fail("self-test failed (see output above)");
    } else {
      note("self-test not built — run `npm run build` then re-run the doctor");
    }
  }

  console.log();
  console.log(`Result: ${counts.ok} ok, ${counts.note} notes, ${counts.fail} failures`);
  if (counts.fail) {
    console.log("Fix the [FAIL] lines above, then re-run: npm run doctor");
    return 1;
  }
  if (usingExample) console.log("Looks good. Copy config.example.jsonc to config.jsonc and keep the models you have.");
  else console.log("Ready. Launch:  node bin/ccmodel.mjs   (or  npm run launch)  — works on Windows, macOS, Linux.");
  return 0;
}

main().then((code) => process.exit(code));
