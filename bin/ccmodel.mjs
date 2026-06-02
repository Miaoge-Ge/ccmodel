#!/usr/bin/env node
/**
 * ccmodel launcher — ONE cross-platform script (Windows / macOS / Linux / WSL).
 *
 * Builds on first run, starts the proxy, points Claude Code at it with gateway
 * model discovery enabled, seeds the discovery cache (so your models + their
 * [1m] variants show on first open), runs `claude`, then stops the proxy on exit.
 * Your normal Claude Code install is untouched (session-scoped --settings + env).
 *
 *   node bin/ccmodel.mjs              # build (first run), launch Claude Code
 *   node bin/ccmodel.mjs --proxy-only # just start the proxy and leave it running
 *   npm run launch                    # same as the first form
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, copyFileSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, statSync, readdirSync } from "node:fs";
import { dirname, join, resolve, delimiter, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const isWin = process.platform === "win32";
const node = process.execPath;
const mainJs = join(repo, "dist", "src", "main.js");
const proxyOnly = process.argv.includes("--proxy-only");
const passthroughArgs = process.argv.slice(2).filter((a) => a !== "--proxy-only");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function which(cmd) {
  if (isAbsolute(cmd) || cmd.includes("/") || cmd.includes("\\")) return existsSync(cmd) ? cmd : null;
  const dirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  const exts = isWin ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const d of dirs) for (const e of exts) {
    const p = join(d, cmd + e);
    try { if (existsSync(p) && statSync(p).isFile()) return p; } catch { /* ignore */ }
  }
  return null;
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: "inherit", ...opts });
}
function npm(args) {
  return run(isWin ? "npm.cmd" : "npm", args, { cwd: repo, shell: isWin });
}

function latestMtimeMs(path) {
  if (!existsSync(path)) return 0;
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  let latest = st.mtimeMs;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      latest = Math.max(latest, latestMtimeMs(child));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".json"))) {
      latest = Math.max(latest, statSync(child).mtimeMs);
    }
  }
  return latest;
}

function needsBuild() {
  if (!existsSync(mainJs)) return true;
  const builtAt = statSync(mainJs).mtimeMs;
  for (const p of [join(repo, "package.json"), join(repo, "tsconfig.json"), join(repo, "src"), join(repo, "scripts")]) {
    if (latestMtimeMs(p) > builtAt) return true;
  }
  return false;
}

async function isHealthy(baseUrl) {
  try {
    const r = await fetch(baseUrl + "/healthz");
    const j = await r.json();
    return j && j.ok === true;
  } catch {
    return false;
  }
}

/** Spawn an interactive child (inherits stdio). Handles Windows .cmd shims. */
function spawnInteractive(file, args, env) {
  if (isWin) {
    const quote = (s) => (/[\s"]/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s);
    const line = [file, ...args].map(quote).join(" ");
    return spawn(line, { stdio: "inherit", env, shell: true });
  }
  return spawn(file, args, { stdio: "inherit", env });
}

async function readProxyConfig(cfgPath) {
  let port = 8141;
  let upstream = "https://api.anthropic.com";
  try {
    const { parseConfigText } = await import(pathToFileURL(join(repo, "dist", "src", "config", "config.js")).href);
    const cfg = parseConfigText(readFileSync(cfgPath, "utf8")) || {};
    if (cfg.port) port = Number(cfg.port);
    if (cfg.upstream) upstream = String(cfg.upstream);
  } catch {
    /* defaults */
  }
  if (process.env.UC_LISTEN_PORT) port = Number(process.env.UC_LISTEN_PORT);
  if (process.env.UC_UPSTREAM) upstream = process.env.UC_UPSTREAM;
  return { port, upstream };
}

async function main() {
  // 1. Claude Code CLI
  const claude = which("claude");
  if (!claude && !proxyOnly) {
    console.error("claude CLI not found — install it with: npm i -g @anthropic-ai/claude-code");
    process.exit(1);
  }

  // 2. Build on first run, or whenever TypeScript sources are newer than dist.
  if (needsBuild()) {
    console.log(existsSync(mainJs) ? "Rebuilding ccmodel (sources changed)..." : "Building ccmodel (first run)...");
    if (!existsSync(join(repo, "node_modules"))) npm(["install"]);
    if (npm(["run", "build"]).status !== 0) {
      console.error("Build failed.");
      process.exit(1);
    }
  }

  // 3. Ensure a config exists.
  let cfgPath = ["config.jsonc", "config.json"].map((n) => join(repo, n)).find(existsSync);
  if (!cfgPath) {
    cfgPath = join(repo, "config.jsonc");
    copyFileSync(join(repo, "config.example.jsonc"), cfgPath);
    console.log("Created config.jsonc from config.example.jsonc — edit it to keep the models you have (and add your keys).");
  }

  // 4. Load optional ccmodel.env (gitignored) for ${VAR} expansion in routes.
  const envFile = join(repo, "ccmodel.env");
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith("#") && t.includes("=")) {
        const i = t.indexOf("=");
        const k = t.slice(0, i).trim();
        if (!(k in process.env)) process.env[k] = t.slice(i + 1).trim();
      }
    }
  }

  // 5. Resolve port + upstream (reuses the compiled config loader).
  const { port, upstream } = await readProxyConfig(cfgPath);
  const baseUrl = `http://127.0.0.1:${port}`;

  // 6. State dir + session settings (your global config is untouched).
  const stateBase = isWin
    ? join(process.env.LOCALAPPDATA || homedir(), "ccmodel")
    : join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "ccmodel");
  mkdirSync(stateBase, { recursive: true });
  const logFile = join(stateBase, "proxy.log");
  const pidFile = join(stateBase, "proxy.pid");
  const settings = join(stateBase, "ccmodel_settings.json");
  writeFileSync(
    settings,
    JSON.stringify({ ultracode: true, env: { ANTHROPIC_BASE_URL: baseUrl, CLAUDE_CODE_WORKFLOWS: "1", CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1" } }, null, 2),
  );

  // 7. Start the proxy (unless one is already healthy on this port).
  const proxyEnv = { ...process.env, UC_CONFIG: cfgPath, UC_LISTEN_PORT: String(port), UC_UPSTREAM: upstream, UC_LOG: logFile };
  let child = null;
  if (!(await isHealthy(baseUrl))) {
    console.log(`Starting ccmodel proxy on ${baseUrl} -> ${upstream} ...`);
    const fd = openSync(logFile, "a");
    child = spawn(node, [mainJs], { env: proxyEnv, stdio: ["ignore", fd, fd], detached: proxyOnly });
    closeSync(fd); // the child keeps its own dup of the fd; don't leak ours
    if (child.pid) writeFileSync(pidFile, String(child.pid));
    let ok = false;
    for (let i = 0; i < 60; i++) {
      if (await isHealthy(baseUrl)) { ok = true; break; }
      await sleep(250);
    }
    if (!ok) {
      console.error(`Proxy did not become healthy on port ${port}. Log: ${logFile}`);
      try { console.error(readFileSync(logFile, "utf8").split(/\r?\n/).slice(-20).join("\n")); } catch { /* ignore */ }
      process.exit(1);
    }
  }
  console.log("Proxy healthy.");

  // 8. Seed Claude Code's gateway-models cache (models + [1m] variants on first open).
  const cfgDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const gwCache = join(cfgDir, "cache", "gateway-models.json");
  const seeded = run(node, [mainJs, "--seed-cache", gwCache, baseUrl], { env: proxyEnv, stdio: "ignore" });
  if (seeded.status !== 0) console.warn(`Warning: couldn't seed ${gwCache} — your models may not show in /model until you reopen it.`);

  if (proxyOnly) {
    if (child) child.unref();
    console.log("\nProxy running (detached). Connect Claude Code with:");
    console.log(`  ANTHROPIC_BASE_URL=${baseUrl}`);
    console.log(`  claude --settings "${settings}"`);
    console.log(`Stop it: node ${join("scripts", "uninstall.mjs")}  (or kill the node process for ${mainJs})`);
    process.exit(0);
  }

  // 9. Launch Claude Code; stop the proxy when it exits.
  const stop = () => { if (child && !child.killed) { try { child.kill(); } catch { /* ignore */ } } };
  process.on("exit", stop);
  process.on("SIGINT", () => { stop(); process.exit(0); });
  process.on("SIGTERM", () => { stop(); process.exit(0); });

  const claudeEnv = { ...process.env, ANTHROPIC_BASE_URL: baseUrl, CLAUDE_CODE_WORKFLOWS: "1", CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1" };
  console.log("Launching Claude Code (ccmodel). Open /model to pick a backend; the [1m] picks run at 1M context.");
  const cp = spawnInteractive(claude, ["--settings", settings, ...passthroughArgs], claudeEnv);
  cp.on("exit", (code) => { stop(); process.exit(code ?? 0); });
  cp.on("error", (e) => { console.error("Failed to launch claude:", e.message); stop(); process.exit(1); });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
