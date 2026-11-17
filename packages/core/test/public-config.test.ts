// The public configuration contract (installations plan, P3, slice 2).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { parsePublicConfig, loadPublicConfig, PUBLIC_CONFIG_VERSION } from "../src/profile/public-config.js";
import { buildPublicConfig, BUILT_IN_FIREBASE_WEB_CONFIG, BUILT_IN_PRIVY_APP_ID } from "../src/profile/public-config-server.js";
import { loadInstallation, resetInstallation } from "../src/profile/runtime.js";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXAMPLE = new URL("./fixtures/installation-example", import.meta.url).pathname;
afterEach(() => resetInstallation());

const TOP_LEVEL = ["auth", "billing", "brand", "catalog", "configVersion", "freePlan", "hosts", "installation", "mcp"];

test("an installation's configuration is exactly the allowlist, from its profile", () => {
  loadInstallation({ PROFILE_DIR: EXAMPLE, INTERNAL_API_KEY: "secret-key", GOOGLE_CLOUD_PROJECT: "example-installation" } as any);
  const c = buildPublicConfig({ INTERNAL_API_KEY: "secret-key" } as any);
  assert.deepEqual(Object.keys(c).sort(), TOP_LEVEL);
  assert.equal(c.configVersion, PUBLIC_CONFIG_VERSION);
  assert.equal(c.installation.id, "example");
  assert.equal(c.brand.name, "Example");
  assert.equal(c.hosts.app, "https://app.example.test");
  assert.equal(c.mcp.endpoint, "https://mcp.example.test/mcp");
  assert.deepEqual(c.auth.firebase, { apiKey: "example-web-key", authDomain: "example-auth.firebaseapp.com", projectId: "example-auth", appId: "1:1:web:example" });
  assert.equal(c.auth.privyAppId, "cexampleprivyapp000000001");
  assert.equal(c.billing.stripePublishableKey, "pk_test_example");
  assert.equal(c.billing.plans.pro.includedItems, 500);
  assert.ok(c.catalog.languages.some(l => l.id === "0180"));
  // Shared authentication is not application storage: the browser never sees the storage project.
  const text = JSON.stringify(c);
  assert.doesNotMatch(text, /example-installation|secret-key|Content-Security-Policy|routingHint|sponsorUid/);
  assert.equal(parsePublicConfig(JSON.parse(text)).ok, true);
});

test("without a profile, today's built-in values", () => {
  const c = buildPublicConfig({} as any);
  assert.equal(c.installation.id, "graffiticode");
  assert.deepEqual(c.auth.firebase, BUILT_IN_FIREBASE_WEB_CONFIG);
  assert.equal(c.auth.privyAppId, BUILT_IN_PRIVY_APP_ID);
  assert.equal(c.hosts.api, "https://api.graffiticode.org");
  assert.equal(parsePublicConfig(JSON.parse(JSON.stringify(c))).ok, true);
  assert.equal(buildPublicConfig({ NEXT_PUBLIC_PRIVY_APP_ID: "cotherprivyapp00000000001" } as any).auth.privyAppId, "cotherprivyapp00000000001");
});

function profileWithout(edit: (p: any) => void) {
  const dir = mkdtempSync(join(tmpdir(), "profile-"));
  cpSync(EXAMPLE, dir, { recursive: true });
  const p = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8"));
  edit(p);
  writeFileSync(join(dir, "profile.json"), JSON.stringify(p));
  return dir;
}

test("a profile must name its own sign-in project and Privy app: nothing is inherited", () => {
  for (const [field, edit] of [["firebase", (p: any) => { delete p.auth.firebase; }], ["privyAppId", (p: any) => { delete p.auth.privyAppId; }]] as const) {
    assert.throws(() => loadInstallation({ PROFILE_DIR: profileWithout(edit), GOOGLE_CLOUD_PROJECT: "example-installation" } as any), new RegExp(field));
    resetInstallation();
  }
});

test("with a profile, the environment supplies no client ids", () => {
  loadInstallation({ PROFILE_DIR: profileWithout(p => { delete p.billing.stripePublishableKey; }), GOOGLE_CLOUD_PROJECT: "example-installation" } as any);
  const c = buildPublicConfig({ NEXT_PUBLIC_PRIVY_APP_ID: "cotherprivyapp00000000001", NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_live_graffiticode" } as any);
  assert.equal(c.auth.privyAppId, "cexampleprivyapp000000001");
  assert.equal(c.auth.firebase.projectId, "example-auth");
  assert.equal(c.billing.stripePublishableKey, null, "no key unless the profile names one");
});

test("a Stripe key is never invented: no test-key fallback", () => {
  const saved = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  try {
    assert.equal(buildPublicConfig({} as any).billing.stripePublishableKey, null);
  } finally {
    if (saved !== undefined) process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = saved;
  }
});

test("malformed or unsupported configurations are refused, never partly used", () => {
  loadInstallation({ PROFILE_DIR: EXAMPLE, GOOGLE_CLOUD_PROJECT: "example-installation" } as any);
  const good = JSON.parse(JSON.stringify(buildPublicConfig({} as any)));
  assert.equal(parsePublicConfig(good).ok, true);
  const bad = (edit: (c: any) => void) => { const c = structuredClone(good); edit(c); return parsePublicConfig(c); };
  assert.match((bad(c => { c.configVersion = 2; }) as any).error, /unsupported configuration version 2/);
  assert.match((bad(c => { delete c.configVersion; }) as any).error, /unsupported configuration version/);
  assert.match((bad(c => { delete c.auth.firebase.apiKey; }) as any).error, /auth\.firebase\.apiKey is missing/);
  assert.match((bad(c => { c.auth.privyAppId = ""; }) as any).error, /privyAppId/);
  assert.match((bad(c => { c.hosts.auth = "not a url"; }) as any).error, /hosts\.auth/);
  assert.match((bad(c => { c.catalog.languages.push({ id: 1 }); }) as any).error, /catalog\.languages\[\d+\]/);
  // Every field is checked, not only its container.
  const refusals: [string, (c: any) => void, RegExp][] = [
    ["an auth host that isn't a URL", c => { c.hosts.auth = "javascript:alert(1)"; }, /hosts\.auth isn't an http\(s\) URL/],
    ["a host with a path", c => { c.hosts.api = "https://api.example.test/v1"; }, /hosts\.api isn't an origin/],
    ["a malformed plan", c => { c.billing.plans.pro.includedItems = "500"; }, /billing\.plans\.pro\.includedItems/],
    ["a plan missing a field", c => { delete c.billing.plans.pro.tier; }, /billing\.plans\.pro\.tier is missing/],
    ["an unknown plan", c => { c.billing.plans.gold = c.billing.plans.pro; }, /billing\.plans\.gold isn't part of the contract/],
    ["an invalid Stripe key", c => { c.billing.stripePublishableKey = "sk_live_secret"; }, /stripePublishableKey isn't in the expected form/],
    ["a negative item lifetime", c => { c.freePlan.itemTtlHours = -1; }, /freePlan\.itemTtlHours isn't a positive number/],
    ["a malformed Firebase app id", c => { c.auth.firebase.appId = "web"; }, /auth\.firebase\.appId/],
    ["a malformed Privy id", c => { c.auth.privyAppId = "x"; }, /auth\.privyAppId/],
    ["a brand link that isn't a URL", c => { c.brand.links.docs = "docs"; }, /brand\.links\.docs/],
    ["a field outside the contract", c => { c.auth.firebase.clientSecret = "x"; }, /auth\.firebase\.clientSecret isn't part of the contract/],
    ["a top-level field outside the contract", c => { c.csp = "default-src *"; }, /configuration\.csp isn't part of the contract/],
    ["a repeated language", c => { c.catalog.languages.push(c.catalog.languages[0]); }, /repeats another language/],
  ];
  for (const [what, edit, expected] of refusals) {
    const r = bad(edit);
    assert.equal(r.ok, false, what);
    assert.match((r as any).error, expected, what);
  }
  assert.equal(parsePublicConfig("[]").ok, false);
  assert.equal(parsePublicConfig(null).ok, false);
});

test("loading fails closed on a failed request, a non-JSON body or an unsupported version", async () => {
  const respond = (status: number, body: string) => (async () => new Response(body, { status })) as any;
  assert.match((await loadPublicConfig("/api/config", respond(500, "oops")) as any).error, /answered 500/);
  assert.match((await loadPublicConfig("/api/config", respond(200, "<html>")) as any).error, /didn't return JSON/);
  assert.match((await loadPublicConfig("/api/config", respond(200, JSON.stringify({ configVersion: 9 }))) as any).error, /unsupported configuration version 9/);
  assert.match((await loadPublicConfig("/api/config", (async () => { throw new Error("offline"); }) as any) as any).error, /couldn't reach/);
});
