import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { watchBadRequests } from "../src/bad-request-log.js";

// The SDK transport answers some /mcp requests 400 and nothing said why; this pins that the
// reason is logged, and that the log carries no session id or request body.

async function serve(status: number, body: string): Promise<{ lines: string[]; url: string; close: () => void }> {
  const lines: string[] = [];
  const server = createServer((req, res) => {
    watchBadRequests(req, res, (l) => lines.push(l));
    req.resume();
    req.on("end", () => res.writeHead(status, { "Content-Type": "application/json" }).end(body));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  return { lines, url: `http://localhost:${port}/mcp`, close: () => server.close() };
}

test("a 400 is logged with the SDK's message and the request's shape", async () => {
  const sdkBody = JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: Server not initialized" }, id: null });
  const s = await serve(400, sdkBody);
  try {
    await (await fetch(s.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "mcp-session-id": "secret-session-123", "User-Agent": "Claude-User", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { arguments: { description: "private prompt" } } }),
    })).text();
    assert.equal(s.lines.length, 1);
    const line = JSON.parse(s.lines[0]);
    assert.deepEqual(
      { ev: line.ev, method: line.method, hasSession: line.hasSession, protocolVersion: line.protocolVersion, client: line.client, message: line.message },
      { ev: "mcp_bad_request", method: "POST", hasSession: true, protocolVersion: "2025-06-18", client: "Claude-User", message: "Bad Request: Server not initialized" },
    );
    assert.ok(!s.lines[0].includes("secret-session-123"), "no session id");
    assert.ok(!s.lines[0].includes("private prompt"), "no request body");
  } finally {
    s.close();
  }
});

test("a body written with write() before a bare end() is still read", async () => {
  const lines: string[] = [];
  const server = createServer((req, res) => {
    watchBadRequests(req, res, (l) => lines.push(l));
    res.writeHead(400, { "Content-Type": "application/json" });
    res.write(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: Mcp-Session-Id header is required" }, id: null }));
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  try {
    await (await fetch(`http://localhost:${port}/mcp`, { method: "POST", body: "{}" })).text();
    assert.equal(JSON.parse(lines[0]).message, "Bad Request: Mcp-Session-Id header is required");
  } finally {
    server.close();
  }
});

test("other statuses are not logged", async () => {
  for (const status of [200, 202, 404]) {
    const s = await serve(status, "{}");
    try {
      await (await fetch(s.url, { method: "POST", body: "{}" })).text();
      assert.equal(s.lines.length, 0, `status ${status}`);
    } finally {
      s.close();
    }
  }
});
