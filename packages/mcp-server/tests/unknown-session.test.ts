import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import test, { after, before } from "node:test";

// Sessions live in memory, so a deploy or restart forgets every one. The MCP spec says a
// request with a session id the server does not hold gets 404, and the client then starts a
// new session by itself. This server answered 400 "Server not initialized" instead, and
// Claude.ai treated that as a dead connector: after each deploy the user had to reconnect by
// hand (observed 2026-10-01). Runs the built server (`npm test` builds first).

const PORT = 3900 + Math.floor(Math.random() * 90);
const URL = `http://localhost:${PORT}/mcp`;
const HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
let server: ChildProcess;

before(async () => {
  server = spawn("node", ["dist/server.js"], {
    env: { ...process.env, PORT: String(PORT), FREE_PLAN_NAMESPACE_SALT: "test-salt-not-a-real-secret" },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://localhost:${PORT}/health`)).ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
});
after(() => {
  server.kill();
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(URL, { method: "POST", headers: { ...HEADERS, ...headers }, body: JSON.stringify(body) });

test("a request on a session the server does not hold gets 404 and a JSON-RPC error", async () => {
  const res = await post(
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { "mcp-session-id": "00000000-0000-0000-0000-000000000000" },
  );
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.error.code, -32001);
});

test("a GET stream on a forgotten session gets 404 too", async () => {
  const res = await fetch(URL, { headers: { ...HEADERS, "mcp-session-id": "forgotten" } });
  assert.equal(res.status, 404);
  await res.body?.cancel();
});

test("initialize, which carries no session id, still starts a session", async () => {
  const res = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("mcp-session-id"));
  await res.body?.cancel();
});
