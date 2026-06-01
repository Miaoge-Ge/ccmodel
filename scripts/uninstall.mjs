#!/usr/bin/env node
/**
 * Cross-platform uninstall. Stops a running proxy (via its pid file), removes the
 * desktop entries and session state. Leaves your config, Claude Code, and
 * ~/.claude credentials alone.
 *
 *   node scripts/uninstall.mjs
 */
import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const isWin = process.platform === "win32";
const desktop = join(homedir(), "Desktop");
const stateBase = isWin
  ? join(process.env.LOCALAPPDATA || homedir(), "ccmodel")
  : join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "ccmodel");

// 1. Stop a running proxy via its pid file.
const pidFile = join(stateBase, "proxy.pid");
if (existsSync(pidFile)) {
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (pid) {
    try {
      process.kill(pid);
      console.log("Stopped proxy pid", pid);
    } catch {
      /* already gone */
    }
  }
}

// 2. Remove desktop entries.
const names = ["CCModel (All Models)", "Claude Code (Normal)"];
const exts = isWin ? [".lnk"] : process.platform === "darwin" ? [".command"] : [".desktop"];
for (const n of names) {
  for (const e of exts) {
    const p = join(desktop, n + e);
    if (existsSync(p)) {
      try {
        unlinkSync(p);
        console.log("Removed:", p);
      } catch {
        /* ignore */
      }
    }
  }
}

// 3. Remove session state.
if (existsSync(stateBase)) {
  rmSync(stateBase, { recursive: true, force: true });
  console.log("Removed state:", stateBase);
}

console.log("\nDone. Your config, Claude Code, and ~/.claude credentials were not touched.");
console.log("To remove everything, delete the repo folder.");
