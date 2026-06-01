/** Tiny timestamped logger. Writes to UC_LOG file if set, else stderr. */
import { appendFileSync } from "node:fs";

const LOG_PATH = process.env.UC_LOG || "";
export const VERBOSE = process.env.UC_VERBOSE === "1";

function ts(): string {
  return new Date().toTimeString().slice(0, 8); // HH:MM:SS
}

export function log(msg: string): void {
  const line = `[${ts()}] ${msg}`;
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
