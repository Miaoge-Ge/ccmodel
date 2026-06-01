#!/usr/bin/env node
/**
 * Cross-platform desktop launcher installer. Creates two entries:
 *   - "CCModel (All Models)"  -> runs bin/ccmodel.mjs (proxy + Claude Code)
 *   - "Claude Code (Normal)"  -> plain claude, your untouched install
 *
 * Uses each OS's native shortcut mechanism:
 *   Windows -> .lnk (via PowerShell WScript.Shell)
 *   macOS   -> .command (executable shell script)
 *   Linux   -> .desktop entry
 *
 *   node scripts/install-icons.mjs
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const node = process.execPath;
const launcher = join(repo, "bin", "ccmodel.mjs");
const desktop = join(homedir(), "Desktop");

function installWindows() {
  const lnk = (name, target, args, desc) => {
    const path = join(desktop, name + ".lnk");
    const ps = [
      "$s = (New-Object -ComObject WScript.Shell).CreateShortcut(" + JSON.stringify(path) + ");",
      "$s.TargetPath = " + JSON.stringify(target) + ";",
      "$s.Arguments = " + JSON.stringify(args) + ";",
      "$s.WorkingDirectory = " + JSON.stringify(repo) + ";",
      "$s.Description = " + JSON.stringify(desc) + ";",
      "$s.Save();",
    ].join(" ");
    const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], { stdio: "inherit" });
    if (r.status === 0) console.log("Created:", path);
    else console.error("Failed to create", path);
  };
  lnk("CCModel (All Models)", node, `"${launcher}"`, "Claude Code with UltraCode + [1m] 1M context on any model");
  const claudeCmd = "/k claude";
  lnk("Claude Code (Normal)", "cmd.exe", claudeCmd, "Plain Claude Code — your normal install, untouched");
}

function installUnixCommand() {
  // macOS: double-clickable .command files.
  const make = (name, body, desc) => {
    const path = join(desktop, name + ".command");
    writeFileSync(path, `#!/bin/bash\n# ${desc}\n${body}\n`, "utf8");
    chmodSync(path, 0o755);
    console.log("Created:", path);
  };
  make("CCModel (All Models)", `cd ${JSON.stringify(repo)} && exec "${node}" "${launcher}"`, "ccmodel launcher");
  make("Claude Code (Normal)", `exec claude`, "Plain Claude Code");
}

function installLinuxDesktop() {
  mkdirSync(desktop, { recursive: true });
  const make = (name, exec, comment) => {
    const path = join(desktop, name + ".desktop");
    writeFileSync(
      path,
      ["[Desktop Entry]", "Type=Application", `Name=${name}`, `Comment=${comment}`, `Exec=${exec}`, "Terminal=true", "Categories=Development;"].join("\n") + "\n",
      "utf8",
    );
    chmodSync(path, 0o755);
    console.log("Created:", path);
  };
  make("CCModel (All Models)", `${node} ${launcher}`, "Claude Code + UltraCode + [1m] 1M context on any model");
  make("Claude Code (Normal)", "claude", "Plain Claude Code");
}

if (process.platform === "win32") installWindows();
else if (process.platform === "darwin") installUnixCommand();
else installLinuxDesktop();

console.log("\nDone. Open 'CCModel (All Models)', then type /model and pick a backend.");
console.log("Picks ending in (1M context) run at a 1,000,000-token context window.");
