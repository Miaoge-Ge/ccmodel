/**
 * Graceful shutdown / connection draining.
 *
 * A blunt `process.exit()` cuts in-flight requests — including long streaming
 * turns — mid-response. Instead we: stop accepting new connections, immediately
 * free idle keep-alive sockets (so the server can actually close), let in-flight
 * requests finish, and only force the stragglers closed after a grace window.
 */
import type { Server } from "node:http";

export interface DrainOptions {
  /** Max time to wait for in-flight requests before forcing sockets closed. */
  graceMs: number;
  /** Called once the server has fully closed (drained or forced). */
  onClosed: () => void;
  log?: (msg: string) => void;
}

/**
 * Drain and close `server`. Resolves via `onClosed` once every connection has
 * ended — either because in-flight requests finished, or the grace timer forced
 * the remaining ones closed.
 */
export function drainServer(server: Server, opts: DrainOptions): void {
  const log = opts.log ?? (() => {});
  let forced = false;

  const timer = setTimeout(() => {
    forced = true;
    log(`drain timeout after ${opts.graceMs}ms — forcing remaining connections closed`);
    // Available on Node's http.Server (>=18.2); guarded for safety.
    server.closeAllConnections?.();
  }, opts.graceMs);
  timer.unref?.();

  server.close(() => {
    clearTimeout(timer);
    log(forced ? "shut down (forced stragglers)" : "drained cleanly");
    opts.onClosed();
  });

  // Free idle keep-alive sockets right away so server.close() isn't held open by
  // connections that aren't actually doing anything.
  server.closeIdleConnections?.();
}
