// The REST API accepts an OAuth access token only when its installation's
// issuer says it is active for this installation's REST resource (installations
// plan, P5 part 1). The issuer's answer is stubbed here.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { introspectOAuthToken, oauthChallenge } from "../src/oauth.ts";
import { createApp } from "../src/app.ts";
import { loadInstallation, resetInstallation } from "@graffiticode-app/core/profile/runtime";

const EXAMPLE = new URL("../../core/test/fixtures/installation-example", import.meta.url).pathname;
afterEach(() => resetInstallation());

let n = 0;
// A fresh token each call, so the 30s answer cache never serves one case to another.
const fresh = () => `gcmcp_at_binding${++n}`;
function issuer(body: Record<string, unknown>) {
  const calls: string[] = [];
  const fetch = (async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { calls, deps: { fetch, identityToken: async (aud: string) => `idt|${aud}` } };
}
const active = (over: Record<string, unknown> = {}) => ({ active: true, token_type: "Bearer", scope: "graffiticode", iss: "https://mcp.example.test", aud: "https://api.example.test/v1", gc_firebase_token: "firebase-id", ...over });

test("an answer for this installation's REST resource, from its issuer, is accepted", async () => {
  loadInstallation({ PROFILE_DIR: EXAMPLE }, { requireStorage: false });
  const { calls, deps } = issuer(active());
  assert.equal(await introspectOAuthToken(fresh(), Date.now(), deps), "firebase-id");
  assert.deepEqual(calls, ["https://mcp.example.test/oauth/introspect"], "asks its own installation's issuer");
  // An issuer that predates the iss field still names the resource; that's enough.
  const { deps: older } = issuer(active({ iss: undefined }));
  assert.equal(await introspectOAuthToken(fresh(), Date.now(), older), "firebase-id");
});

test("an active answer for another resource or another issuer is refused", async () => {
  loadInstallation({ PROFILE_DIR: EXAMPLE }, { requireStorage: false });
  for (const over of [
    { aud: "https://openapi.graffiticode.org/v1" },
    { aud: "https://mcp.example.test/mcp" },
    { aud: undefined },
    { iss: "https://mcp.graffiticode.org" },
    { active: false },
  ]) {
    const { deps } = issuer(active(over));
    assert.equal(await introspectOAuthToken(fresh(), Date.now(), deps), null, JSON.stringify(over));
  }
});

// The example installation, declaring only its MCP resource.
function withoutRestResource() {
  const dir = mkdtempSync(join(tmpdir(), "profile-no-rest-"));
  cpSync(EXAMPLE, dir, { recursive: true });
  const p = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8"));
  delete p.auth.resources.openapi;
  delete p.copy["openapi.oauth2.description"]; // its template names the REST resource
  writeFileSync(join(dir, "profile.json"), JSON.stringify(p, null, 2));
  return dir;
}

// Everything the API advertises about OAuth.
async function advertised() {
  const app = createApp();
  const spec = await (await app.request("http://x/v1/openapi.json")).json();
  const ops = Object.values(spec.paths).flatMap((item: any) => Object.values(item)).filter((op: any) => op && typeof op === "object" && "security" in op) as any[];
  const mentions = (security: any[] | undefined) => (security ?? []).some(alt => "oauth2" in alt);
  return {
    scheme: "oauth2" in (spec.components.securitySchemes ?? {}),
    globalAlternative: mentions(spec.security),
    operationAlternatives: ops.filter(op => mentions(op.security)).length,
    operations: ops.length,
    otherAlternatives: ops.every(op => op.security.some((alt: any) => "bearerAuth" in alt || Object.keys(alt).length === 0)),
    metadata: [(await app.request("http://x/.well-known/oauth-protected-resource")).status, (await app.request("http://x/.well-known/oauth-protected-resource/v1")).status],
    authenticated: ops.filter(op => op.security.some((alt: any) => Object.keys(alt).length > 0)).length,
    challenge: (oauthChallenge() as any).fields.headers["WWW-Authenticate"] as string,
  };
}

test("with a REST resource declared, the API advertises its OAuth flow", async () => {
  loadInstallation({ PROFILE_DIR: EXAMPLE }, { requireStorage: false });
  const a = await advertised();
  assert.equal(a.scheme, true);
  assert.equal(a.globalAlternative, true);
  assert.ok(a.authenticated > 0);
  assert.equal(a.operationAlternatives, a.authenticated, "every authenticated operation offers OAuth");
  assert.deepEqual(a.metadata, [200, 200]);
  assert.match(a.challenge, /resource_metadata="https:\/\/api\.example\.test\/\.well-known\/oauth-protected-resource\/v1"/);
});

test("without a REST resource, nothing advertises OAuth: no flow, no alternative, no metadata", async () => {
  loadInstallation({ PROFILE_DIR: withoutRestResource() }, { requireStorage: false });
  const a = await advertised();
  assert.equal(a.scheme, false);
  assert.equal(a.globalAlternative, false);
  assert.equal(a.operationAlternatives, 0);
  assert.equal(a.otherAlternatives, true, "API keys and the rest are still offered");
  assert.deepEqual(a.metadata, [404, 404]);
  assert.doesNotMatch(a.challenge, /resource_metadata/, "a challenge points at no metadata");
});

test("an installation that declares no REST resource accepts no OAuth token and asks nobody", async () => {
  loadInstallation({ PROFILE_DIR: withoutRestResource() }, { requireStorage: false });
  const { calls, deps } = issuer(active());
  assert.equal(await introspectOAuthToken(fresh(), Date.now(), deps), null);
  assert.deepEqual(calls, []);
});
