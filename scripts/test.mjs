#!/usr/bin/env node
/**
 * Portable test runner. Enumerates dist/test/**​/*.test.js and passes the explicit
 * file list to `node --test`, which every supported Node (20/22/24) accepts —
 * unlike `--test "<glob>"`, whose glob expansion only landed in Node 21.
 *
 *   node scripts/test.mjs              run the suite
 *   node scripts/test.mjs --coverage   run with V8 coverage
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDir = join(repo, "dist", "test");

function findTests(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findTests(p));
    else if (entry.name.endsWith(".test.js")) out.push(p);
  }
  return out;
}

const files = findTests(testDir).sort();
if (files.length === 0) {
  console.error("No compiled tests found in dist/test — run `npm run build` first.");
  process.exit(1);
}

const coverage = process.argv.includes("--coverage");
const args = ["--test", ...(coverage ? ["--experimental-test-coverage"] : []), ...files];
const result = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
