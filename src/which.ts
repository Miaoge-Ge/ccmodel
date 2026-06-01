/** Cross-platform `which`: resolve a command to an absolute path, or null. */
import { existsSync, statSync } from "node:fs";
import { join, isAbsolute, delimiter } from "node:path";

export function which(cmd: string): string | null {
  if (!cmd) return null;
  // Absolute/explicit path: accept if it exists.
  if (isAbsolute(cmd) || cmd.includes("/") || cmd.includes("\\")) {
    return existsSync(cmd) ? cmd : null;
  }
  const pathDirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const dir of pathDirs) {
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        // ignore
      }
    }
  }
  return null;
}
