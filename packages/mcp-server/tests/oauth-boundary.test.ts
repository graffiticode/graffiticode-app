// The OAuth boundary between installations (installations plan, P5 part 1).
//
// Two installations share one OAuth store, as they do until the store
// handover: Graffiticode (A, today's defaults) and an example installation
// (B). Without a profile, hosts are resolved from the environment on each
// call, so each step below runs as one installation or the other. The store
// is an in-memory stand-in for the auth service.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import {
  LEGACY_RESOURCE,
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_REFRESH_TOKEN_PREFIX,
  handleAuthorize,
  handleCallback,
  handleClientRegistration,
  handleProtectedResourceMetadata,
  handleToken,
  resolveOAuthAccessToken,
} from "../src/oauth/handlers.js";
import { introspect, introspectionAudience } from "../src/oauth/introspection.js";
import { oauthStore } from "../src/oauth/firestore-store.js";
import type { AuthorizationCode, OAuthClient, PendingAuth, TokenEntry } from "../src/oauth/types.js";

delete process.env.PROFILE_DIR;

type Installation = { name: string; env: Record<string, string | undefined> };
const HOST_VARS = ["MCP_SERVER_URL", "MCP_OAUTH_URL", "OPENAPI_RESOURCE", "OPENAPI_PUBLIC_URL", "CONSOLE_URL", "GRAFFITICODE_CONSOLE_BASE_URL", "OAUTH_INTROSPECTION_CALLERS"];
const A: Installation = { name: "graffiticode", env: {} };
const B: Installation = {
  name: "example",
  env: {
    MCP_SERVER_URL: "https://mcp.example.test",
    OPENAPI_RESOURCE: "https://api.example.test/v1",
    CONSOLE_URL: "https://console.example.test",
    OAUTH_INTROSPECTION_CALLERS: "openapi-run@example-installation.iam.gserviceaccount.com",
  },
};
const MCP = { A: "https://mcp.graffiticode.org/mcp", B: "https://mcp.example.test/mcp" };
const REST = { A: "https://openapi.graffiticode.org/v1", B: "https://api.example.test/v1" };
const REST_CALLER = { A: "openapi-run@graffiticode-app.iam.gserviceaccount.com", B: "openapi-run@example-installation.iam.gserviceaccount.com" };

async function as<T>(inst: Installation, fn: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(HOST_VARS.map(k => [k, process.env[k]]));
  for (const k of HOST_VARS) delete process.env[k];
  Object.assign(process.env, inst.env);
  try {
    return await fn();
  } finally {
    for (const k of HOST_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// --- the shared store ----------------------------------------------------------

const clients = new Map<string, OAuthClient>();
const pendings = new Map<string, PendingAuth>();
const codes = new Map<string, AuthorizationCode>();
const tokens = new Map<string, TokenEntry>();
const byRefresh = (rt: string) => [...tokens.values()].find(t => t.refresh_token === rt) ?? null;
const clone = <T>(x: T): T => (x === undefined || x === null ? x : JSON.parse(JSON.stringify(x)));
Object.assign(oauthStore, {
  registerClient: async (c: OAuthClient) => void clients.set(c.client_id, clone(c)),
  getClient: async (id: string) => clone(clients.get(id)),
  savePendingAuth: async (p: PendingAuth) => void pendings.set(p.state, clone(p)),
  getPendingAuth: async (s: string) => clone(pendings.get(s)),
  deletePendingAuth: async (s: string) => void pendings.delete(s),
  saveAuthCode: async (c: AuthorizationCode) => void codes.set(c.code, clone(c)),
  getAuthCode: async (c: string) => clone(codes.get(c)),
  markAuthCodeUsed: async (c: string) => void (codes.get(c)!.used = true),
  deleteAuthCode: async (c: string) => void codes.delete(c),
  saveToken: async (_p: string, _e: string, t: TokenEntry) => void tokens.set(t.access_token, clone(t)),
  getTokenByAccessToken: async (at: string) => clone(tokens.get(at) ?? null),
  getTokenByRefreshToken: async (rt: string) => clone(byRefresh(rt)),
  updateToken: async (at: string, u: Partial<TokenEntry>) => void Object.assign(tokens.get(at)!, u),
  deleteToken: async (at: string) => void tokens.delete(at),
  rotateTokens: async (old: string, next: TokenEntry) => {
    const prev = byRefresh(old);
    if (prev) tokens.delete(prev.access_token);
    tokens.set(next.access_token, clone(next));
  },
});

// --- HTTP stand-ins --------------------------------------------------------------

function request(method: string, url: string, body = "") {
  const r = Readable.from(body ? [Buffer.from(body)] : []) as any;
  r.method = method;
  r.url = url;
  r.headers = { host: "localhost" };
  return r;
}
function response() {
  const r: any = { status: 0, headers: {}, raw: "" };
  r.writeHead = (status: number, headers?: Record<string, string>) => ((r.status = status), (r.headers = headers ?? {}), r);
  r.end = (b?: string) => void (r.raw = b ?? "");
  Object.defineProperty(r, "json", { get: () => (r.raw ? JSON.parse(r.raw) : null) });
  return r;
}
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

async function register(): Promise<string> {
  const res = response();
  await handleClientRegistration(request("POST", "/oauth/register", JSON.stringify({ client_name: "Agent", redirect_uris: ["https://agent.example/cb"] })), res);
  assert.equal(res.status, 201);
  assert.equal("issuer" in res.json, false, "the registration response is unchanged");
  return res.json.client_id;
}
// A real PKCE pair, so a code exchange gets past PKCE to the checks under test.
const VERIFIER = "v".repeat(64);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
async function authorize(clientId: string, resource?: string) {
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: "https://agent.example/cb", response_type: "code", state: "s", code_challenge: CHALLENGE, code_challenge_method: "S256" });
  if (resource) q.set("resource", resource);
  const res = response();
  await handleAuthorize(request("GET", `/oauth/authorize?${q}`), res);
  return res;
}
async function token(body: Record<string, string>) {
  const res = response();
  await handleToken(request("POST", "/oauth/token", form(body)), res);
  return res;
}
let n = 0;
function seedToken(over: Partial<TokenEntry> & { client_id: string }): TokenEntry {
  n++;
  const entry: TokenEntry = {
    access_token: `${OAUTH_ACCESS_TOKEN_PREFIX}seed${n}`,
    refresh_token: `${OAUTH_REFRESH_TOKEN_PREFIX}seed${n}`,
    scope: "graffiticode",
    firebase_id_token: `firebase-${n}`,
    firebase_refresh_token: `firebase-refresh-${n}`,
    firebase_token_expires_at: Date.now() + 3_600_000,
    resource: MCP.A,
    created_at: Date.now(),
    ...over,
  };
  if (!over.resource && "resource" in over) delete (entry as any).resource;
  tokens.set(entry.access_token, clone(entry));
  return entry;
}
function seedClient(issuer?: string): string {
  const id = `client-${++n}`;
  clients.set(id, { client_id: id, client_name: "Agent", redirect_uris: ["https://agent.example/cb"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", client_id_issued_at: 0, ...(issuer ? { issuer } : {}) });
  return id;
}
// Google's verification, by audience: "idt|<email>|<audience>".
const verify = async (t: string, audience: string) => {
  const [kind, email, aud] = t.split("|");
  if (kind !== "idt" || aud !== audience) throw new Error("bad identity token");
  return { email, email_verified: true };
};
const restCaller = async (inst: "A" | "B") => as(inst === "A" ? A : B, () => `Bearer idt|${REST_CALLER[inst]}|${introspectionAudience()}`);
const introspectAt = (inst: Installation, authorization: string, t: string) => as(inst, () => introspect({ authorization, token: t, verify }));

// --- tokens can't cross installations or resources -----------------------------

test("an access token works only at the resource and installation it was issued for", async () => {
  const client = seedClient();
  const cases: Array<[string, Installation, string]> = [["A mcp", A, MCP.A], ["A rest", A, REST.A], ["B mcp", B, MCP.B], ["B rest", B, REST.B]];
  for (const [label, , resource] of cases) {
    const t = seedToken({ client_id: client, resource });
    for (const [where, inst, expected] of cases) {
      const r = await as(inst, () => resolveOAuthAccessToken(t.access_token, expected));
      if (where === label) assert.deepEqual(r, { status: "valid", firebaseToken: t.firebase_id_token }, `${label} at ${where}`);
      else assert.deepEqual(r, { status: "invalid", reason: "resource" }, `${label} token refused at ${where}`);
    }
  }
});

test("a token is never valid for a resource the installation doesn't declare", async () => {
  // Bound to the very resource asked about, but A doesn't declare it.
  const t = seedToken({ client_id: seedClient(), resource: "https://undeclared.example/v1" });
  assert.deepEqual(await as(A, () => resolveOAuthAccessToken(t.access_token, "https://undeclared.example/v1")), { status: "invalid", reason: "resource" });
});

test("introspection answers only for this installation's REST resource, to its own REST service", async () => {
  const client = seedClient();
  const restA = seedToken({ client_id: client, resource: REST.A });
  const restB = seedToken({ client_id: client, resource: REST.B });
  const mcpA = seedToken({ client_id: client, resource: MCP.A });
  const ok = await introspectAt(A, await restCaller("A"), restA.access_token);
  assert.equal(ok.body.active, true);
  assert.equal(ok.body.aud, REST.A);
  assert.equal(ok.body.iss, "https://mcp.graffiticode.org");
  assert.equal((await introspectAt(B, await restCaller("B"), restB.access_token)).body.aud, REST.B);

  assert.deepEqual((await introspectAt(A, await restCaller("A"), restB.access_token)).body, { active: false }, "B's REST token at A");
  assert.deepEqual((await introspectAt(B, await restCaller("B"), restA.access_token)).body, { active: false }, "A's REST token at B");
  assert.deepEqual((await introspectAt(A, await restCaller("A"), mcpA.access_token)).body, { active: false }, "an MCP token isn't a REST token");
  // A's REST service can't ask B, nor B's ask A: wrong audience, and not a listed caller.
  assert.equal((await introspectAt(B, await restCaller("A"), restB.access_token)).status, 401);
  assert.equal((await introspectAt(A, await restCaller("B"), restA.access_token)).status, 401);
});

// --- authorization rejects undeclared resources and other installations' clients --

test("authorization issues only for this installation's declared resources", async () => {
  const clientB = await as(B, register);
  for (const resource of [MCP.A, REST.A, "https://evil.example/mcp", `${MCP.B}/`]) {
    const res = await as(B, () => authorize(clientB, resource));
    assert.equal(res.status, 400, resource);
    assert.equal(res.json.error, "invalid_target", resource);
  }
  for (const resource of [undefined, MCP.B, REST.B]) {
    const res = await as(B, () => authorize(clientB, resource));
    assert.equal(res.status, 302, String(resource));
    const consent = new URL(res.headers.Location);
    assert.equal(consent.origin, "https://console.example.test");
    assert.equal(consent.searchParams.get("callback_url"), "https://mcp.example.test/oauth/callback");
    assert.equal(pendings.get(consent.searchParams.get("state")!)!.resource, resource ?? MCP.B);
  }
  const meta = response();
  await as(B, () => handleProtectedResourceMetadata(request("GET", "/.well-known/oauth-protected-resource"), meta));
  assert.deepEqual(meta.json, { resource: MCP.B, authorization_servers: ["https://mcp.example.test"] });
});

test("a client registered with one installation is unknown at the other", async () => {
  const clientA = await as(A, register);
  const clientB = await as(B, register);
  assert.equal(clients.get(clientA)!.issuer, "https://mcp.graffiticode.org");
  assert.equal(clients.get(clientB)!.issuer, "https://mcp.example.test");
  const crossed = [await as(B, () => authorize(clientA)), await as(A, () => authorize(clientB)), await as(B, () => authorize(seedClient()))];
  for (const res of crossed) assert.deepEqual([res.status, res.json.error], [400, "invalid_client"]);
  assert.equal((await as(A, () => authorize(clientA))).status, 302);
});

test("a pending authorization and a code are redeemable only at their own installation", async () => {
  const clientA = await as(A, register);
  const consent = new URL((await as(A, () => authorize(clientA))).headers.Location);
  const state = consent.searchParams.get("state")!;
  const cb = response();
  await as(B, () => handleCallback(request("POST", "/oauth/callback", form({ state, grant: "g" })), cb));
  assert.deepEqual([cb.status, cb.json.error], [400, "invalid_request"]);
  assert.ok(pendings.has(state), "B leaves A's pending authorization alone");
  const declined = response();
  await as(B, () => handleCallback(request("POST", "/oauth/callback", form({ state, error: "access_denied" })), declined));
  assert.equal(declined.status, 400, "B doesn't redirect for A's pending authorization");
  assert.ok(pendings.has(state));

  const ok = response();
  await as(A, () => handleCallback(request("POST", "/oauth/callback", form({ state, grant: "g" })), ok));
  assert.equal(ok.status, 303);
  const code = new URL(ok.headers.Location).searchParams.get("code")!;
  const res = await as(B, () => token({ grant_type: "authorization_code", code, client_id: clientA, redirect_uri: "https://agent.example/cb", code_verifier: VERIFIER }));
  assert.deepEqual([res.status, res.json.error], [400, "invalid_grant"]);
  assert.equal(codes.get(code)!.used, false, "B neither consumes nor marks A's code");
});

// --- refresh and introspection keep the original binding ------------------------

test("refresh keeps the resource it was granted, at its own installation only", async () => {
  const clientA = seedClient("https://mcp.graffiticode.org");
  const mcpA = seedToken({ client_id: clientA, resource: MCP.A });
  const restA = seedToken({ client_id: clientA, resource: REST.A });

  // B refuses A's refresh tokens and leaves them as they were.
  for (const t of [mcpA, restA]) {
    const res = await as(B, () => token({ grant_type: "refresh_token", refresh_token: t.refresh_token!, client_id: clientA }));
    assert.deepEqual([res.status, res.json.error], [400, "invalid_grant"]);
    assert.ok(tokens.has(t.access_token));
  }
  // Refresh never moves a token to another resource.
  const widened = await as(A, () => token({ grant_type: "refresh_token", refresh_token: mcpA.refresh_token!, client_id: clientA, resource: REST.A }));
  assert.deepEqual([widened.status, widened.json.error], [400, "invalid_target"]);

  // Each rotation keeps the binding: the MCP token stays MCP-only, the REST one REST-only.
  const nextMcp = await as(A, () => token({ grant_type: "refresh_token", refresh_token: mcpA.refresh_token!, client_id: clientA }));
  const nextRest = await as(A, () => token({ grant_type: "refresh_token", refresh_token: restA.refresh_token!, client_id: clientA, resource: REST.A }));
  assert.equal(nextMcp.status, 200);
  assert.equal(nextRest.status, 200);
  assert.equal(tokens.get(nextMcp.json.access_token)!.resource, MCP.A);
  assert.equal(tokens.get(nextRest.json.access_token)!.resource, REST.A);
  assert.equal(tokens.has(mcpA.access_token), false, "rotated away");

  assert.equal((await as(A, () => resolveOAuthAccessToken(nextMcp.json.access_token))).status, "valid");
  assert.deepEqual((await introspectAt(A, await restCaller("A"), nextMcp.json.access_token)).body, { active: false });
  assert.deepEqual(await as(A, () => resolveOAuthAccessToken(nextRest.json.access_token)), { status: "invalid", reason: "resource" });
  const active = await introspectAt(A, await restCaller("A"), nextRest.json.access_token);
  assert.deepEqual([active.body.active, active.body.aud], [true, REST.A]);
  // And still nowhere at B.
  assert.deepEqual(await as(B, () => resolveOAuthAccessToken(nextMcp.json.access_token, MCP.B)), { status: "invalid", reason: "resource" });
  assert.deepEqual((await introspectAt(B, await restCaller("B"), nextRest.json.access_token)).body, { active: false });
});

test("a token of B's own client is refreshed at B, never at A", async () => {
  const clientB = seedClient("https://mcp.example.test");
  const t = seedToken({ client_id: clientB, resource: MCP.B });
  const atA = await as(A, () => token({ grant_type: "refresh_token", refresh_token: t.refresh_token!, client_id: clientB }));
  assert.deepEqual([atA.status, atA.json.error], [400, "invalid_grant"]);
  const atB = await as(B, () => token({ grant_type: "refresh_token", refresh_token: t.refresh_token!, client_id: clientB }));
  assert.equal(atB.status, 200);
  assert.equal(tokens.get(atB.json.access_token)!.resource, MCP.B);
});

test("refresh needs both the resource and the client to be this installation's", async () => {
  const clientB = seedClient("https://mcp.example.test");
  // A's resource, B's client: refused at A by the client.
  const t1 = seedToken({ client_id: clientB, resource: MCP.A });
  const r1 = await as(A, () => token({ grant_type: "refresh_token", refresh_token: t1.refresh_token!, client_id: clientB }));
  assert.deepEqual([r1.status, r1.json.error], [400, "invalid_grant"]);
  // A's resource, B's client: refused at B by the resource.
  const r2 = await as(B, () => token({ grant_type: "refresh_token", refresh_token: t1.refresh_token!, client_id: clientB }));
  assert.deepEqual([r2.status, r2.json.error], [400, "invalid_grant"]);
  // A's resource, its client since deleted: refused at B by the resource alone.
  const gone = seedClient("https://mcp.graffiticode.org");
  const t3 = seedToken({ client_id: gone, resource: MCP.A });
  clients.delete(gone);
  const r3 = await as(B, () => token({ grant_type: "refresh_token", refresh_token: t3.refresh_token!, client_id: gone }));
  assert.deepEqual([r3.status, r3.json.error], [400, "invalid_grant"]);
  // B's resource, its B client since deleted: refused at B too. A token is
  // refreshed only for a client record this installation owns.
  const goneB = seedClient("https://mcp.example.test");
  const t4 = seedToken({ client_id: goneB, resource: MCP.B });
  clients.delete(goneB);
  const r4 = await as(B, () => token({ grant_type: "refresh_token", refresh_token: t4.refresh_token!, client_id: goneB }));
  assert.deepEqual([r4.status, r4.json.error], [400, "invalid_grant"]);
  // No legacy exception: a Graffiticode token whose client is gone isn't refreshed either.
  const goneLegacy = seedClient();
  const t5 = seedToken({ client_id: goneLegacy, resource: undefined });
  clients.delete(goneLegacy);
  const r5 = await as(A, () => token({ grant_type: "refresh_token", refresh_token: t5.refresh_token!, client_id: goneLegacy }));
  assert.deepEqual([r5.status, r5.json.error], [400, "invalid_grant"]);
  for (const t of [t1, t3, t4, t5]) assert.ok(tokens.has(t.access_token), "left as it was");
});

// --- existing Graffiticode clients and tokens ----------------------------------

test("a legacy pending authorization or code is bound to Graffiticode's MCP resource throughout", async () => {
  const legacyClient = seedClient();
  // A pending authorization from before resources were recorded makes a code bound explicitly.
  pendings.set("legacy-state", { state: "legacy-state", client_id: legacyClient, redirect_uri: "https://agent.example/cb", scope: "graffiticode", code_challenge: CHALLENGE, code_challenge_method: "S256", created_at: Date.now(), client_state: "s" } as any);
  const cb = response();
  await as(A, () => handleCallback(request("POST", "/oauth/callback", form({ state: "legacy-state", grant: "g" })), cb));
  assert.equal(cb.status, 303);
  const made = new URL(cb.headers.Location).searchParams.get("code")!;
  assert.equal(codes.get(made)!.resource, MCP.A);

  // A code from before resources were recorded: naming its resource (or not) is the same request.
  for (const resource of [undefined, MCP.A]) {
    const code = `legacy-code-${resource ?? "omitted"}`;
    codes.set(code, { code, client_id: legacyClient, redirect_uri: "https://agent.example/cb", scope: "graffiticode", code_challenge: CHALLENGE, code_challenge_method: "S256", grant: "g", grant_state: "x", expires_at: Date.now() + 60_000, used: false } as any);
    const res = await as(A, () => token({ grant_type: "authorization_code", code, client_id: legacyClient, redirect_uri: "https://agent.example/cb", code_verifier: VERIFIER, ...(resource ? { resource } : {}) }));
    assert.notEqual(res.json?.error, "invalid_target", String(resource));
    assert.equal(codes.get(code)?.used ?? true, true, `${resource}: past every check (the consent grant itself isn't redeemable here)`);
  }
  const wrong = "legacy-code-rest";
  codes.set(wrong, { code: wrong, client_id: legacyClient, redirect_uri: "https://agent.example/cb", scope: "graffiticode", code_challenge: CHALLENGE, code_challenge_method: "S256", grant: "g", grant_state: "x", expires_at: Date.now() + 60_000, used: false } as any);
  const res = await as(A, () => token({ grant_type: "authorization_code", code: wrong, client_id: legacyClient, redirect_uri: "https://agent.example/cb", code_verifier: VERIFIER, resource: REST.A }));
  assert.deepEqual([res.status, res.json.error], [400, "invalid_target"]);
  assert.equal(codes.get(wrong)!.used, false);
});

test("records from before installations are Graffiticode's: they keep working there, nowhere else", async () => {
  assert.equal(LEGACY_RESOURCE, MCP.A);
  const legacyClient = seedClient(); // no issuer
  assert.equal((await as(A, () => authorize(legacyClient))).status, 302, "an existing client still authorizes at Graffiticode");
  assert.equal((await as(A, () => authorize(legacyClient, REST.A))).status, 302, "for either of its resources");

  const legacy = seedToken({ client_id: legacyClient, resource: undefined }); // no resource
  assert.equal("resource" in tokens.get(legacy.access_token)!, false);
  assert.equal((await as(A, () => resolveOAuthAccessToken(legacy.access_token))).status, "valid", "valid at Graffiticode's /mcp");
  assert.deepEqual((await introspectAt(A, await restCaller("A"), legacy.access_token)).body, { active: false }, "never for REST");
  assert.deepEqual(await as(B, () => resolveOAuthAccessToken(legacy.access_token, MCP.B)), { status: "invalid", reason: "resource" });

  const atB = await as(B, () => token({ grant_type: "refresh_token", refresh_token: legacy.refresh_token!, client_id: legacyClient }));
  assert.deepEqual([atB.status, atB.json.error], [400, "invalid_grant"]);
  const atA = await as(A, () => token({ grant_type: "refresh_token", refresh_token: legacy.refresh_token!, client_id: legacyClient }));
  assert.equal(atA.status, 200, "an existing refresh token still refreshes at Graffiticode");
  assert.deepEqual(Object.keys(atA.json).sort(), ["access_token", "expires_in", "refresh_token", "scope", "token_type"]);
  assert.equal(tokens.get(atA.json.access_token)!.resource, MCP.A, "its binding, now explicit");
  assert.equal((await as(A, () => resolveOAuthAccessToken(atA.json.access_token))).status, "valid");
});

test("with a profile, only that installation's REST service may introspect, by default", async () => {
  const { loadInstallation, resetInstallation } = await import("@graffiticode-app/core/profile/runtime");
  const { introspectionCallers } = await import("../src/oauth/introspection.js");
  const saved = process.env.OAUTH_INTROSPECTION_CALLERS;
  delete process.env.OAUTH_INTROSPECTION_CALLERS;
  try {
    assert.deepEqual(introspectionCallers(), [REST_CALLER.A], "without a profile: Graffiticode's, as today");
    loadInstallation({ PROFILE_DIR: new URL("../../core/test/fixtures/installation-example", import.meta.url).pathname }, { requireStorage: false });
    assert.deepEqual(introspectionCallers(), [REST_CALLER.B]);
  } finally {
    resetInstallation();
    if (saved !== undefined) process.env.OAUTH_INTROSPECTION_CALLERS = saved;
  }
});
