// Parity gate for extracting Graffiticode into an installation profile
// (installations plan, P2). Every brand-bearing surface of the running server
// is captured and compared byte for byte with snapshots recorded from the code
// before extraction:
//   - without PROFILE_DIR (the built-in behavior, unchanged until gc-deploy
//     mounts profiles), and
//   - with the Graffiticode profile installed (PROFILE_DIR), when that profile
//     directory is available locally. Until its repo exists it lives beside
//     this one (GRAFFITICODE_PROFILE_DIR, default ../installation-graffiticode).
// Re-record only for an intended change: UPDATE_PARITY_SNAPSHOTS=1.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const SNAPSHOT = new URL("./snapshots/graffiticode-surfaces.json", import.meta.url).pathname;
const PROFILE = resolve(process.env.GRAFFITICODE_PROFILE_DIR ?? new URL("../../../../installation-graffiticode", import.meta.url).pathname);

const PAGES = ["/about", "/privacy", "/terms", "/robots.txt", "/", "/mcp.json", "/.well-known/mcp.json"];
// One client per widget route (widgetRouteFor): mcp-apps, openai, none.
const CLIENTS = [
  { name: "claude-ai", capabilities: { extensions: { "io.modelcontextprotocol/ui": {} } } },
  { name: "openai-mcp", capabilities: {} },
  { name: "some-editor", capabilities: {} },
];

async function startServer(env: Record<string, string>): Promise<{ port: number; child: ChildProcess }> {
  const port = 3990 + Math.floor(Math.random() * 400);
  const child = spawn("node", ["dist/server.js"], {
    env: { ...process.env, PORT: String(port), FREE_PLAN_NAMESPACE_SALT: "test-salt-not-a-real-secret", ...env },
    stdio: "ignore",
  });
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`http://localhost:${port}/health`)).ok) return { port, child };
    } catch {
      /* not listening yet */
    }
    await new Promise(r => setTimeout(r, 100));
  }
  child.kill();
  throw new Error("server did not start");
}

const rpcBody = async (res: Response) => {
  const text = await res.text();
  const data = text.trim().startsWith("{") ? text : text.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5)).join("");
  return JSON.parse(data);
};

async function capture(port: number) {
  const base = `http://localhost:${port}`;
  const out: Record<string, unknown> = {};
  for (const p of PAGES) {
    const r = await fetch(base + p);
    out[`GET ${p}`] = { status: r.status, type: r.headers.get("content-type"), body: await r.text() };
  }
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  for (const client of CLIENTS) {
    const init = await fetch(`${base}/mcp`, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: client.capabilities, clientInfo: { name: client.name, version: "1.0.0" } } }),
    });
    const session = init.headers.get("mcp-session-id")!;
    const initResult = (await rpcBody(init)).result;
    await fetch(`${base}/mcp`, { method: "POST", headers: { ...headers, "mcp-session-id": session }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    const list = await fetch(`${base}/mcp`, { method: "POST", headers: { ...headers, "mcp-session-id": session }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
    out[`initialize ${client.name}`] = { serverInfo: initResult.serverInfo, instructions: initResult.instructions, capabilities: initResult.capabilities };
    out[`tools/list ${client.name}`] = (await rpcBody(list)).result;
  }
  return out;
}

async function surfaces(env: Record<string, string>) {
  const { port, child } = await startServer(env);
  try {
    return await capture(port);
  } finally {
    child.kill();
  }
}

test("without a profile, every Graffiticode surface is unchanged", async () => {
  const now = await surfaces({});
  if (process.env.UPDATE_PARITY_SNAPSHOTS === "1") {
    mkdirSync(new URL("./snapshots/", import.meta.url).pathname, { recursive: true });
    writeFileSync(SNAPSHOT, JSON.stringify(now, null, 2) + "\n");
  }
  assert.deepEqual(now, JSON.parse(readFileSync(SNAPSHOT, "utf8")));
});

test("with the Graffiticode profile installed, every surface is byte-identical", { skip: !existsSync(`${PROFILE}/profile.json`) && `no Graffiticode profile at ${PROFILE}` }, async () => {
  const now = await surfaces({ PROFILE_DIR: PROFILE });
  const expected = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  for (const key of Object.keys(expected)) assert.deepEqual(now[key], expected[key], key);
});

test("the profile is what the surfaces read: a different profile changes them", { skip: !existsSync(`${PROFILE}/profile.json`) && `no Graffiticode profile at ${PROFILE}` }, async () => {
  const { cpSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/profile-`);
  cpSync(PROFILE, dir, { recursive: true, filter: src => !src.includes("/.git") });
  const p = JSON.parse(readFileSync(`${dir}/profile.json`, "utf8"));
  p.installation.id = "example";
  p.brand.name = "Example";
  p.hosts.mcp = "https://mcp.example.test";
  p.auth = { issuer: "https://mcp.example.test", resources: { ...p.auth.resources, mcp: "https://mcp.example.test/mcp" } };
  p.brand.links.forum = "https://forum.example.test";
  writeFileSync(`${dir}/profile.json`, JSON.stringify(p));
  writeFileSync(`${dir}/legal/terms.html`, "<p>Example terms</p>\n");

  const { port, child } = await startServer({ PROFILE_DIR: dir });
  try {
    const base = `http://localhost:${port}`;
    assert.equal(await (await fetch(`${base}/terms`)).text(), "<p>Example terms</p>");
    assert.match(await (await fetch(`${base}/robots.txt`)).text(), /^# Example MCP server — https:\/\/mcp\.example\.test\n/);
    const discovery = await (await fetch(`${base}/mcp.json`)).json();
    assert.equal(discovery.mcp_endpoint, "https://mcp.example.test/mcp");
    assert.equal(discovery.forum_url, "https://forum.example.test");
    assert.match(discovery.description, /^Example is a universal MCP server/);
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.installation.installationId, "example");
    assert.match(health.installation.profileDigest, /^[0-9a-f]{64}$/);
    const init = await fetch(`${base}/mcp`, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } }),
    });
    assert.equal((await rpcBody(init)).result.serverInfo.name, "example");
  } finally {
    child.kill();
  }
});

test("an invalid profile stops the server from starting", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/profile-`);
  writeFileSync(`${dir}/profile.json`, JSON.stringify({ profileVersion: 1 }));
  await assert.rejects(startServer({ PROFILE_DIR: dir }), /server did not start/);
});
