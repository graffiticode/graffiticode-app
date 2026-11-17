// Parity gate for extracting Graffiticode into an installation profile
// (installations plan, P2). Every brand-bearing surface of the running server
// is captured and compared byte for byte with snapshots recorded from the code
// before extraction:
//   - without PROFILE_DIR (the built-in behavior, unchanged until gc-deploy
//     mounts profiles), and
//   - with the Graffiticode profile installed (PROFILE_DIR): an integration
//     gate that runs only when GRAFFITICODE_PROFILE_DIR names that profile.
// The checks that a profile is actually what the surfaces read, and that an
// invalid profile or template stops the start, always run, against the
// committed example installation (core/test/fixtures/installation-example).
// Re-record only for an intended change: UPDATE_PARITY_SNAPSHOTS=1.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const SNAPSHOT = new URL("./snapshots/graffiticode-surfaces.json", import.meta.url).pathname;
const PROFILE = process.env.GRAFFITICODE_PROFILE_DIR ? resolve(process.env.GRAFFITICODE_PROFILE_DIR) : null;
const EXAMPLE = new URL("../../core/test/fixtures/installation-example", import.meta.url).pathname;

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

test("with the Graffiticode profile installed, every surface is byte-identical", { skip: !PROFILE && "integration gate: set GRAFFITICODE_PROFILE_DIR to the Graffiticode profile" }, async () => {
  assert.ok(existsSync(`${PROFILE}/profile.json`), `no profile at ${PROFILE}`);
  const now = await surfaces({ PROFILE_DIR: PROFILE });
  const expected = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  for (const key of Object.keys(expected)) assert.deepEqual(now[key], expected[key], key);
});

test("the profile is what the surfaces read: the example installation's surfaces are its own", async () => {
  const { port, child } = await startServer({ PROFILE_DIR: EXAMPLE });
  try {
    const base = `http://localhost:${port}`;
    assert.equal(await (await fetch(`${base}/terms`)).text(), "<p>Example terms</p>");
    assert.equal(await (await fetch(`${base}/robots.txt`)).text(), "# Example MCP server — https://mcp.example.test\n\nUser-agent: *\nAllow: /");
    assert.deepEqual(await (await fetch(`${base}/mcp.json`)).json(), {
      mcp_endpoint: "https://mcp.example.test/mcp",
      site: "https://mcp.example.test",
      description: "Example is a universal MCP server for testing.",
      tools: ["create_item", "update_item", "get_item", "render_item", "get_spec", "list_languages", "get_language_info"],
      product_url: "https://example.test",
      console_url: "https://console.example.test",
      forum_url: "https://forum.example.test",
      github_url: "https://example.test/source",
    });
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.installation.installationId, "example");
    assert.match(health.installation.profileDigest, /^[0-9a-f]{64}$/);
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    const init = await fetch(`${base}/mcp`, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } }),
    });
    const session = init.headers.get("mcp-session-id")!;
    const result = (await rpcBody(init)).result;
    assert.equal(result.serverInfo.name, "example");
    assert.equal(result.instructions, "Example makes things. Call list_languages to find the language first.\n\nUse the tools at https://console.example.test.");
    await fetch(`${base}/mcp`, { method: "POST", headers: { ...headers, "mcp-session-id": session }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    const list = await fetch(`${base}/mcp`, { method: "POST", headers: { ...headers, "mcp-session-id": session }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
    const tools = (await rpcBody(list)).result.tools;
    assert.equal(tools.find((t: any) => t.name === "create_item").description, "Create an item with Example.");
    // A tool the profile doesn't word keeps its built-in description.
    assert.match(tools.find((t: any) => t.name === "get_item").description, /^Get an existing Graffiticode item by ID\./);
  } finally {
    child.kill();
  }
});

test("a copy template naming a value the profile doesn't have stops the start", async () => {
  const { cpSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/profile-`);
  cpSync(EXAMPLE, dir, { recursive: true });
  writeFileSync(`${dir}/copy/mcp-robots.txt`, "# {{hosts.nope}}\n");
  await assert.rejects(startServer({ PROFILE_DIR: dir }), /server did not start/);
});

test("an invalid profile stops the server from starting", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/profile-`);
  writeFileSync(`${dir}/profile.json`, JSON.stringify({ profileVersion: 1 }));
  await assert.rejects(startServer({ PROFILE_DIR: dir }), /server did not start/);
});

test("the MCP server's advertised endpoint, its OAuth resource and its issuer agree", async () => {
  for (const env of [{ PROFILE_DIR: EXAMPLE }, { MCP_SERVER_URL: "https://mcp.staging.test" }]) {
    const { port, child } = await startServer(env);
    try {
      const base = `http://localhost:${port}`;
      const discovery = await (await fetch(`${base}/mcp.json`)).json();
      const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
      const server = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
      assert.equal(resource.resource, discovery.mcp_endpoint, "the OAuth resource is the advertised endpoint");
      assert.deepEqual(resource.authorization_servers, [server.issuer]);
      assert.equal(server.authorization_endpoint, `${server.issuer}/oauth/authorize`);
      assert.equal(new URL(server.issuer).origin, new URL(discovery.site).origin);
    } finally {
      child.kill();
    }
  }
});

test("with a profile, a contradicting host variable stops the start; a repeated one doesn't", async () => {
  await assert.rejects(startServer({ PROFILE_DIR: EXAMPLE, MCP_SERVER_URL: "https://mcp.graffiticode.org" }), /server did not start/);
  await assert.rejects(startServer({ PROFILE_DIR: EXAMPLE, CONSOLE_URL: "https://console.graffiticode.org" }), /server did not start/);
  const { child } = await startServer({ PROFILE_DIR: EXAMPLE, MCP_SERVER_URL: "https://mcp.example.test", CONSOLE_URL: "https://console.example.test" });
  child.kill();
});
