/** Small id helpers (random hex, message/tool ids). */
import { randomBytes } from "node:crypto";

/** Return `len` lowercase hex chars. */
export function randomHex(len: number): string {
  return randomBytes(Math.ceil(len / 2))
    .toString("hex")
    .slice(0, len);
}

export function newMsgId(): string {
  return "msg_" + randomHex(24);
}

export function newToolId(): string {
  return "toolu_" + randomHex(16);
}
