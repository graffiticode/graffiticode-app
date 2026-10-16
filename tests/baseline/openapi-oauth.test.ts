// Phase 4c: OAuth access tokens on the REST API, checked by the authorization
// server's introspection endpoint (mcp's POST /oauth/introspect), here a fake
// on loopback that checks the caller's identity token as mcp does.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { start, userToken, type Harness } from "./harness";

let h: Harness;
let app: any;
let protocol: any;
let server: http.Server;
let origin: string;
const asked: Array<{ identity: string; token: string }> = [];
let down = false;

before(async () => {
  h = await start();
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", c => { raw += c; });
    req.on("end", () => {
      const identity = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      const token = new URLSearchParams(raw).get("token") ?? "";
      asked.push({ identity, token });
      if (down) { res.writeHead(500); return res.end(); }
      if (!identity.startsWith("idt|") || !identity.endsWith(`|${origin}/oauth/introspect`)) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "invalid_client" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(token === "gcmcp_at_good"
        ? { active: true, scope: "graffiticode", aud: "https://openapi.test/v1", gc_firebase_token: userToken("alice") }
        : { active: false }));
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.MCP_OAUTH_URL = origin;
  process.env.OPENAPI_PUBLIC_URL = "https://openapi.test/v1";
  protocol = await import("@graffiticode-app/core/generation-protocol");
  app = (await import("../../packages/openapi-server/src/app.ts")).createApp();
});
after(async () => { server?.close(); await h?.stop(); });
beforeEach(async () => {
  await h.resetFirestore();
  await h.db.doc("system/generation-protocol").set({ minProtocol: 2 });
  protocol.resetProtocolFloorCache();
  asked.length = 0;
  down = false;
});

const call = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
  app.request(`http://x${path}`, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });

test("an access token issued for this API acts as its user", async () => {
  const res = await call("POST", "/v1/items", { Authorization: "Bearer gcmcp_at_good" }, { language: "L0175", description: "Write a short literary passage about a lighthouse keeper." });
  assert.equal(res.status, 202);
  await h.drainJobs();
  const { id } = await res.json();
  assert.ok((await h.db.doc(`users/alice/items/${id}`).get()).exists, "made in alice's account");
  assert.equal(asked.length, 1);
  assert.match(asked[0].identity, /^idt\|console-run@.*\|http:\/\/127\.0\.0\.1:\d+\/oauth\/introspect$/, "our own identity, for the introspection endpoint");
  // Cached: the next request doesn't ask again.
  assert.equal((await call("GET", `/v1/items/${id}`, { Authorization: "Bearer gcmcp_at_good" })).status, 200);
  assert.equal(asked.length, 1);
});

test("an inactive token is a 401 pointing at the resource metadata", async () => {
  const res = await call("GET", "/v1/me", { Authorization: "Bearer gcmcp_at_revoked" });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.code, "invalid_token");
  assert.match(res.headers.get("www-authenticate"), /error="invalid_token", resource_metadata="https:\/\/openapi\.test\/\.well-known\/oauth-protected-resource\/v1"/);
});

test("if introspection is down, a 503 to retry — never a pass", async () => {
  down = true;
  const res = await call("GET", "/v1/me", { Authorization: "Bearer gcmcp_at_other" });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "5");
});

test("protected-resource metadata names mcp's authorization server", async () => {
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/v1"]) {
    const m = await (await call("GET", path)).json();
    assert.deepEqual(m.authorization_servers, [origin]);
    assert.equal(m.resource, "https://openapi.test/v1");
    assert.deepEqual(m.scopes_supported, ["graffiticode"]);
  }
});
