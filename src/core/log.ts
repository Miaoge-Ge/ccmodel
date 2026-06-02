/** Tiny timestamped logger. Writes to UC_LOG file if set, else stderr. */
import { appendFileSync } from "node:fs";

const LOG_PATH = process.env.UC_LOG || "";
export const VERBOSE = process.env.UC_VERBOSE === "1";

function ts(): string {
  return new Date().toTimeString().slice(0, 8); // HH:MM:SS
}

const REDACTIONS: Array<[RegExp, string]> = [
  // authorization / x-api-key / api-key header values (keeping a "Bearer " label)
  [/((?:x-api-key|api[_-]?key|authorization)["':=\s]+(?:bearer\s+)?)[^\s,"'}]{6,}/gi, "$1[redacted]"],
  // bare "Bearer <token>"
  [/(bearer\s+)[A-Za-z0-9._\-]{6,}/gi, "$1[redacted]"],
  // common provider key shapes (sk-…, sk-ant-…, sk-proj-…) anywhere in the text
  [/\b(sk(?:-[a-z]+)?)-[A-Za-z0-9]{8,}/g, "$1-[redacted]"],
];

/**
 * Strip credentials before anything is written to disk/stderr. Defense-in-depth:
 * an upstream error body (which we log a slice of) can echo back an auth header,
 * and a misconfigured inline key could otherwise reach the log file.
 */
export function redactSecrets(msg: string): string {
  let out = msg;
  for (const [re, sub] of REDACTIONS) out = out.replace(re, sub);
  return out;
}

export function log(msg: string): void {
  const line = `[${ts()}] ${redactSecrets(msg)}`;
  if (LOG_PATH) {
    try {
      appendFileSync(LOG_PATH, line + "\n", { encoding: "utf-8" });
      return;
    } catch {
      // fall through to stderr
    }
  }
  process.stderr.write(line + "\n");
}

export function vlog(msg: string): void {
  if (VERBOSE) log(msg);
}
