// The REST API as a second OAuth resource, and POST /oauth/introspect.
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateTokenValidity, isAllowedResource, OAUTH_ACCESS_TOKEN_PREFIX, openapiResource } from "../src/oauth/handlers.js";
import { introspect, introspectionAudience } from "../src/oauth/introspection.js";

const MCP = "https://mcp.graffiticode.org/mcp";
const NOW = 1_000_000_000_000;
const OPENAPI = "openapi-run@graffiticode-app.iam.gserviceaccount.com";

// Stands for Google's verification: "idt|<email>|<audience>".
const verify = async (token: string, audience: string) => {
  const [kind, email, aud] = token.split("|");
  if (kind !== "idt" || aud !== audience) throw new Error("bad identity token");
  return { email, email_verified: true };
};
const caller = (email = OPENAPI, aud = introspectionAudience()) => `Bearer idt|${email}|${aud}`;
const token = `${OAUTH_ACCESS_TOKEN_PREFIX}abc`;
const resolved: Array<[string, string]> = [];
const resolve = (async (t: string, resource: string) => {
  resolved.push([t, resource]);
  return t === token ? { status: "valid", firebaseToken: "firebase-id-token" } : { status: "invalid", reason: "revoked" };
}) as any;

test("the authorization server issues for MCP and for the REST API, nothing else", () => {
  assert.equal(openapiResource(), "https://openapi.graffiticode.org/v1");
  assert.equal(isAllowedResource(MCP), true);
  assert.equal(isAllowedResource(openapiResource()), true);
  assert.equal(isAllowedResource("https://evil.example/v1"), false);
  assert.equal(isAllowedResource(`${openapiResource()}/`), false);
});

test("strict resource binding: a legacy token with no resource is valid for /mcp only", () => {
  const legacy = { scope: "graffiticode", created_at: NOW - 1000 };
  assert.equal(evaluateTokenValidity(legacy, MCP, NOW), null);
  assert.equal(evaluateTokenValidity(legacy, openapiResource(), NOW), "resource");
  const forMcp = { ...legacy, resource: MCP };
  assert.equal(evaluateTokenValidity(forMcp, openapiResource(), NOW), "resource", "a /mcp token can't be used for REST");
  const forRest = { ...legacy, resource: openapiResource() };
  assert.equal(evaluateTokenValidity(forRest, openapiResource(), NOW), null);
  assert.equal(evaluateTokenValidity(forRest, MCP, NOW), "resource", "a REST token can't be used for /mcp");
});

test("introspection refuses any caller but the REST service's identity", async () => {
  for (const authorization of [undefined, "Bearer nonsense", caller("mcp-run@graffiticode-app.iam.gserviceaccount.com"), caller(OPENAPI, "https://other.example")]) {
    const r = await introspect({ authorization, token, verify, resolve });
    assert.equal(r.status, 401, String(authorization));
    assert.deepEqual(r.body, { error: "invalid_client" });
  }
  assert.equal(resolved.length, 0, "no token is looked up for a refused caller");
});

test("introspection answers active only for a live token bound to the REST resource", async () => {
  const ok = await introspect({ authorization: caller(), token, verify, resolve });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { active: true, token_type: "Bearer", scope: "graffiticode", iss: "https://mcp.graffiticode.org", aud: openapiResource(), gc_firebase_token: "firebase-id-token" });
  assert.deepEqual(resolved.at(-1), [token, openapiResource()], "looked up for the REST resource");
  assert.deepEqual((await introspect({ authorization: caller(), token: `${OAUTH_ACCESS_TOKEN_PREFIX}gone`, verify, resolve })).body, { active: false });
  assert.deepEqual((await introspect({ authorization: caller(), token: "gc_live_apikey", verify, resolve })).body, { active: false }, "an API key isn't an OAuth token");
  assert.deepEqual((await introspect({ authorization: caller(), token: undefined, verify, resolve })).body, { active: false });
});
