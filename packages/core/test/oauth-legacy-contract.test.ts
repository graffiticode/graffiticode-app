// The migration contract (installations plan, P5: the OAuth-store handover),
// against the stand-in. The same suite runs against the real auth service
// (mcp-server/tests/oauth-legacy-contract.test.ts); only that run can clear
// the migration's activation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { defineLegacyContractSuite } from "../src/oauth/legacy-contract-suite.js";
import { LegacyStandIn } from "../src/oauth/legacy-standin.js";
import { oauthStoreMode, OAuthStoreConfigError } from "../src/oauth/store.js";
import { LEGACY_CONTRACT_VERSION } from "../src/oauth/legacy-contract.js";

defineLegacyContractSuite(test, async () => {
  const source = new LegacyStandIn();
  return { source, installation: "graffiticode", fence: async () => source.fence("graffiticode"), seal: async () => source.seal("graffiticode") };
});

const GC = "https://mcp.graffiticode.org";
const OTHER = "https://mcp.example.test";
const refuses = (env: Record<string, string>, issuer: string, pattern: RegExp) =>
  assert.throws(() => oauthStoreMode(env, issuer), (e: any) => e instanceof OAuthStoreConfigError && pattern.test(e.message));

test("deploying changes nothing: the store is legacy unless configured", () => {
  assert.equal(oauthStoreMode({}, GC), "legacy");
  assert.equal(oauthStoreMode({ OAUTH_STORE: "legacy" }, OTHER), "legacy");
});

test("migrating is Graffiticode's, and only once the real service was verified against this contract version", () => {
  refuses({ OAUTH_STORE: "migrating" }, GC, /OAUTH_MIGRATION_VERIFIED_CONTRACT=1/);
  refuses({ OAUTH_STORE: "migrating", OAUTH_MIGRATION_VERIFIED_CONTRACT: String(LEGACY_CONTRACT_VERSION + 1) }, GC, /OAUTH_MIGRATION_VERIFIED_CONTRACT/);
  refuses({ OAUTH_STORE: "migrating", OAUTH_MIGRATION_VERIFIED_CONTRACT: "1" }, OTHER, /Graffiticode's/);
  assert.equal(oauthStoreMode({ OAUTH_STORE: "migrating", OAUTH_MIGRATION_VERIFIED_CONTRACT: "1" }, GC), "migrating");
});

test("local has no fallback: any other installation, or Graffiticode once its fallback is retired", () => {
  assert.equal(oauthStoreMode({ OAUTH_STORE: "local" }, OTHER), "local");
  refuses({ OAUTH_STORE: "local" }, GC, /OAUTH_LEGACY_FALLBACK_RETIRED=1/);
  assert.equal(oauthStoreMode({ OAUTH_STORE: "local", OAUTH_LEGACY_FALLBACK_RETIRED: "1" }, GC), "local");
  refuses({ OAUTH_STORE: "shared" }, GC, /unknown OAUTH_STORE/);
});
