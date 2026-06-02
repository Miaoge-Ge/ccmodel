/** Unit tests for graceful connection draining. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { drainServer } from "../../src/core/shutdown.js";

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
  );
}

test("drainServer lets an in-flight request finish, then closes", async () => {
  // Signal the moment the request reaches the handler — by then the connection is
  // active, so draining is deterministic (no sleep-based race with closeIdleConnections).
  let handlingStarted!: () => void;
  const handling = new Promise<void>((r) => (handlingStarted = r));
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    handlingStarted();
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("done");
    }, 80);
  });
  const base = await listen(server);

  let closed = false;
  const inflight = fetch(base + "/x"); // keep it in-flight
  await handling; // the request is now actively being handled

  const drained = new Promise<void>((resolve) =>
    drainServer(server, {
      graceMs: 2000,
      onClosed: () => {
        closed = true;
        resolve();
      },
    }),
  );

  const resp = await inflight;
  assert.equal(resp.status, 200, "in-flight request completed, not cut off");
  assert.equal(await resp.text(), "done");
  await drained;
  assert.equal(closed, true, "server reported fully closed after the request drained");
});

test("drainServer force-closes a hung request after the grace window", async () => {
  let handlingStarted!: () => void;
  const handling = new Promise<void>((r) => (handlingStarted = r));
  const server = createServer(() => handlingStarted() /* never responds */);
  const base = await listen(server);

  const hung = fetch(base + "/x").catch((e) => `err:${(e as Error).name}`);
  await handling; // the hung request is actively held open

  const start = Date.now();
  await new Promise<void>((resolve) => drainServer(server, { graceMs: 150, onClosed: resolve }));
  const elapsed = Date.now() - start;

  assert.ok(elapsed >= 100, "waited for the grace window before forcing the socket closed");
  assert.ok(elapsed < 3000, "did not hang indefinitely");
  await hung; // the forced close rejects the client fetch — fine
});
