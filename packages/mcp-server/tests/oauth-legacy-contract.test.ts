// The migration contract against the real auth service, through this server's
// HTTP client (src/oauth/firestore-store.ts): the same suite the stand-in
// passes (core/src/oauth/legacy-contract-suite.ts).
//
// It runs only against a disposable auth service, because it sets a fence that
// is never lifted: OAUTH_LEGACY_CONTRACT_URL names it, and INTERNAL_API_KEY is
// its internal key. Skipped otherwise. Passing it there is what lets an
// operator set OAUTH_MIGRATION_VERIFIED_CONTRACT and activate the migration;
// the stand-in passing clears nothing.
import test from "node:test";
import { defineLegacyContractSuite } from "@graffiticode-app/core/oauth/legacy-contract-suite";

const URL_ = process.env.OAUTH_LEGACY_CONTRACT_URL;
const run = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: !URL_ && "set OAUTH_LEGACY_CONTRACT_URL (and INTERNAL_API_KEY) to a disposable auth service" }, fn);

defineLegacyContractSuite(run, async () => {
  delete process.env.PROFILE_DIR;
  process.env.GRAFFITICODE_AUTH_URL = URL_!;
  const { legacySource } = await import("../src/oauth/firestore-store.js");
  return { source: legacySource, installation: "graffiticode", fence: () => legacySource.fence("graffiticode"), seal: () => legacySource.seal("graffiticode") };
});
