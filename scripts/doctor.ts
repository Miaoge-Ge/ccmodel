#!/usr/bin/env node
/**
 * ccmodel doctor: verify the machine is ready, validate config, and run the
 * offline self-test. Exit code is non-zero if anything REQUIRED is missing.
 *
 *   node dist/scripts/doctor.js            # full check
 *   node dist/scripts/doctor.js --no-test  # skip the self-test
 *   node dist/scripts/doctor.js --ci       # don't fail on a missing claude CLI
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { REPO_ROOT, parseConfigText, inferType } from "../src/config/config.js";
import { validateConfig } from "../src/config/validate.js";
import { which } from "../src/core/which.js";
import type { Config } from "../src/config/types.js";

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
const PLACEHOLDER = /REPLACE_WITH|your-|YOUR_|sk-xxx|sk-\.\.\./i;

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: "127.0.0.1", port });
    sock.setTimeout(700);
    sock.on("connect", () => {
      sock.destroy();
      resolve(false);
    });
    sock.on("timeout", () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(true));
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

  // 2. build present
  existsSync(join(REPO_ROOT, "dist", "src", "main.js")) ? ok("build present (dist/src/main.js)") : fail("not built — run: npm run build");

  // 3. claude CLI
  const claude = which("claude");
  if (claude) ok(`claude CLI on PATH: ${claude}`);
  else if (ci) note("claude CLI not found (CI mode — skipping)");
  else fail("claude CLI not found — install: npm i -g @anthropic-ai/claude-code");

  // 4. config
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
  ok(`config has ${models.length} model(s)`);

  // 5. structural validation (shared with the server)
  const { errors, warnings } = validateConfig(cfg);
  for (const w of warnings) note(w);
  for (const e of errors) fail(e);

  // 6. per-model credential checks
  for (const e of models) {
    if (!e || typeof e !== "object" || typeof e.model !== "string") continue;
    const label = e.name || e.model;
    const type = inferType(typeof e.url === "string" ? e.url : undefined, e.api);
    if (type === "codex_oauth") {
      const auth = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
      existsSync(auth)
        ? ok(`model '${label}': Codex login found`)
        : note(`model '${label}': no ${auth} — run \`codex login\` before using it`);
      continue;
    }
    if (type === "cursor_agent") {
      const binp = process.env.CURSOR_AGENT_BIN || which("cursor-agent") || join(homedir(), ".local", "bin", "cursor-agent");
      binp && existsSync(binp)
        ? ok(`model '${label}': cursor-agent found`)
        : note(`model '${label}': cursor-agent not found — install it and run \`cursor-agent login\` (experimental)`);
      continue;
    }
    const refs = new Set(referencedVars(e.key));
    for (const hv of Object.values(e.headers || {})) for (const r of referencedVars(hv)) refs.add(r);
    for (const v of [...refs].sort()) {
      if (process.env[v]) ok(`model '${label}': env var ${v} is set`);
      else if (usingExample) note(`model '${label}': ${v} not set yet (example; set it once you keep this model)`);
      else fail(`model '${label}': ${v} is empty — set it (env or ccmodel.env) or inline the key`);
    }
    if (refs.size === 0 && typeof e.key === "string" && PLACEHOLDER.test(e.key)) {
      usingExample
        ? note(`model '${label}': key is a placeholder — put your real key there`)
        : fail(`model '${label}': key is still a placeholder`);
    }
  }

  // 7. port free
  // Match main.ts precedence: an explicit env var wins, else config, else default.
  const envPort = process.env.UC_LISTEN_PORT;
  const port = envPort !== undefined && envPort !== "" ? Number(envPort) || 8141 : Number(cfg.port) || 8141;
  (await portFree(port))
    ? ok(`port ${port} is free`)
    : note(`port ${port} already in use — a proxy may already be running (fine), or pick another`);

  // 8. offline self-test (the end-to-end integration suite exercises the whole proxy)
  const testFile = join(REPO_ROOT, "dist", "test", "integration.test.js");
  if (!noTest) {
    if (existsSync(testFile)) {
      console.log("\nrunning offline self-test (node --test)...");
      const rc = spawnSync(process.execPath, ["--test", testFile], { stdio: "inherit" }).status;
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
  if (usingExample) console.log("Looks good. Copy config.example.jsonc to config.jsonc and add your keys.");
  else console.log("Ready. Launch:  npm run launch   (works on Windows, macOS, Linux).");
  return 0;
}

main().then((code) => process.exit(code));
