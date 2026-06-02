/** Unit tests for the HTTP client + header helpers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { requestUpstream } from "../../src/net/http.js";
import { applyAuthHeader, forwardRequestHeaders, flatten, HOP_BY_HOP, readBody, BodyTooLargeError } from "../../src/net/httpUtil.js";

function startServer(handler: Parameters<typeof createServer>[1]): Promise<{ base: string; server: Server }> {
  const server = createServer(handler);
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server })),
  );
}

test("forwardRequestHeaders drops hop-by-hop and forces identity encoding", () => {
  const out = forwardRequestHeaders({
    "content-type": "application/json",
    host: "x",
    connection: "keep-alive",
    "transfer-encoding": "chunked",
    "x-keep": "yes",
  });
  assert.equal(out["x-keep"], "yes");
  assert.equal(out["content-type"], "application/json");
  assert.equal(out.host, undefined, "host stripped");
  assert.equal(out.connection, undefined, "connection stripped");
  assert.equal(out["Accept-Encoding"], "identity");
  assert.ok(HOP_BY_HOP.has("transfer-encoding"));
});

test("flatten joins array header values", () => {
  assert.equal(flatten(["a", "b"]), "a, b");
  assert.equal(flatten("x"), "x");
  assert.equal(flatten(undefined), "");
});

test("applyAuthHeader: bearer replaces inbound creds; custom header form respected", () => {
  const h1: Record<string, string> = { authorization: "Bearer old", "x-api-key": "old" };
  applyAuthHeader(h1, "Bearer new");
  assert.equal(h1["Authorization"], "Bearer new");
  assert.equal(h1["authorization"], undefined, "old-cased inbound auth removed");
  assert.equal(h1["x-api-key"], undefined, "inbound x-api-key removed");

  const h2: Record<string, string> = {};
  applyAuthHeader(h2, "x-api-key: sk-xyz");
  assert.equal(h2["x-api-key"], "sk-xyz");
});

test("requestUpstream returns 4xx/5xx without throwing", async () => {
  const { base, server } = await startServer((_req, res) => {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end('{"e":"down"}');
  });
  try {
    const resp = await requestUpstream({ url: base + "/x", method: "GET" });
    assert.equal(resp.status, 503);
    assert.equal(await resp.text(), '{"e":"down"}');
  } finally {
    server.close();
  }
});

test("requestUpstream streams chunks and echoes the body", async () => {
  const { base, server } = await startServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("echo:" + body);
    });
  });
  try {
    const resp = await requestUpstream({ url: base + "/x", method: "POST", body: "ping" });
    let out = "";
    for await (const chunk of resp.chunks()) out += chunk.toString("utf-8");
    assert.equal(out, "echo:ping");
  } finally {
    server.close();
  }
});

test("requestUpstream rejects promptly when the signal is already aborted", async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => requestUpstream({ url: "http://127.0.0.1:1/x", method: "GET", signal: ac.signal }));
});

test("readBody buffers within the cap and rejects beyond it", async () => {
  const { base, server } = await startServer((req, res) => {
    readBody(req, 10).then(
      (buf) => {
        res.writeHead(200);
        res.end("ok:" + buf.length);
      },
      (e) => {
        res.writeHead(e instanceof BodyTooLargeError ? 413 : 500);
        res.end((e as Error).name);
      },
    );
  });
  try {
    assert.equal(await (await fetch(base + "/x", { method: "POST", body: "tiny" })).text(), "ok:4");
    const big = await fetch(base + "/x", { method: "POST", body: "x".repeat(100) });
    assert.equal(big.status, 413);
    assert.equal(await big.text(), "BodyTooLargeError");
  } finally {
    server.close();
  }
});

test("readBody with no cap (0) buffers any size", async () => {
  const { base, server } = await startServer((req, res) => {
    readBody(req, 0).then((buf) => {
      res.writeHead(200);
      res.end(String(buf.length));
    });
  });
  try {
    assert.equal(await (await fetch(base + "/x", { method: "POST", body: "y".repeat(5000) })).text(), "5000");
  } finally {
    server.close();
  }
});
