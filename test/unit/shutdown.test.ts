/** Unit tests for graceful connection draining. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { drainServer } from "../../src/core/shutdown.js";

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
  );
}

test("drainServer lets an in-flight request finish, then closes", async () => {
  // Handler delays its response so a request is genuinely in-flight at drain time.
  const server = createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("done");
    }, 120);
  });
  const base = await listen(server);

  let closed = false;
  const inflight = fetch(base + "/x"); // do NOT await yet — keep it in-flight
  await new Promise((r) => setTimeout(r, 20)); // ensure the request has landed

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
  // Handler never responds — only the grace timeout can end the connection.
  const server = createServer(() => {
    /* intentionally hang */
  });
  const base = await listen(server);

  const hung = fetch(base + "/x").catch((e) => `err:${(e as Error).name}`);
  await new Promise((r) => setTimeout(r, 20));

  const start = Date.now();
  await new Promise<void>((resolve) => drainServer(server, { graceMs: 100, onClosed: resolve }));
  const elapsed = Date.now() - start;

  assert.ok(elapsed >= 90, "waited roughly the grace window before forcing");
  assert.ok(elapsed < 2000, "did not hang indefinitely");
  await hung; // the forced close rejects the client fetch — fine
});
