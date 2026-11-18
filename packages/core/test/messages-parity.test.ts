// Per-message parity for core's free-plan refusals (installations plan, P2).
// Recorded before extraction; compared without a profile and with the
// Graffiticode profile (integration gate, GRAFFITICODE_PROFILE_DIR); the
// example installation always runs. UPDATE_PARITY_SNAPSHOTS=1 re-records.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildMonthlyQuotaError, buildScopeError, buildItemExpiredError, buildDailyPaceError } from "../src/lib/free-plan-quota.js";
import { buildSessionInvalidError, buildSignupUrl } from "../src/lib/free-plan-context.js";
import { buildBurstError } from "../src/lib/free-plan-throttle.js";
import { describeWriteProblem } from "../src/lib/write-errors.js";
import { loadInstallation, resetInstallation } from "../src/profile/runtime.js";
import { installationBrand } from "../src/profile/brand.js";

const SNAPSHOT = new URL("./snapshots/graffiticode-messages.json", import.meta.url).pathname;
const PROFILE = process.env.GRAFFITICODE_PROFILE_DIR ? resolve(process.env.GRAFFITICODE_PROFILE_DIR) : null;
const EXAMPLE = new URL("./fixtures/installation-example", import.meta.url).pathname;
afterEach(() => resetInstallation());

const payload = (e: any) => e.payload;
function messages() {
  return {
    monthly: payload(buildMonthlyQuotaError(5, 5)),
    scope: payload(buildScopeError("L0176", ["0180", "0179"])),
    expired: payload(buildItemExpiredError()),
    daily: payload(buildDailyPaceError(3, new Date(Date.UTC(2026, 10, 16, 12)))),
    sessionInvalid: payload(buildSessionInvalidError()),
    burst: payload(buildBurstError(7, 20, 60)),
    systemConnectionWrite: describeWriteProblem({ status: "failed", message: "system-connection" } as any, installationBrand().name),
    signup: buildSignupUrl("item_limit"),
    signupBranded: buildSignupUrl("item_limit", "assessments"),
  };
}

test("without a profile, every refusal is unchanged", () => {
  const now = messages();
  if (process.env.UPDATE_PARITY_SNAPSHOTS === "1") {
    mkdirSync(new URL("./snapshots/", import.meta.url).pathname, { recursive: true });
    writeFileSync(SNAPSHOT, JSON.stringify(now, null, 2) + "\n");
  }
  assert.deepEqual(now, JSON.parse(readFileSync(SNAPSHOT, "utf8")));
});

test("with the Graffiticode profile, every refusal is byte-identical", { skip: !PROFILE && "integration gate: set GRAFFITICODE_PROFILE_DIR to the Graffiticode profile" }, () => {
  assert.ok(existsSync(`${PROFILE}/profile.json`), `no profile at ${PROFILE}`);
  loadInstallation({ PROFILE_DIR: PROFILE! });
  assert.deepEqual(messages(), JSON.parse(readFileSync(SNAPSHOT, "utf8")));
});

test("with the example installation, refusals name it and its signup page", () => {
  loadInstallation({ PROFILE_DIR: EXAMPLE });
  const m = messages();
  assert.equal(m.monthly.message, "The Example free plan has reached its item limit for this month. Create a free account at example.test/signup to keep creating items.");
  assert.match(m.scope.message, /is not available on the Example free plan\. .* at example\.test\/signup to use every language\.$/);
  assert.match(m.expired.message, /at example\.test\/signup to keep items permanently\.$/);
  assert.match(m.daily.message, /^The Example free plan has reached its item limit for today/);
  assert.match(m.sessionInvalid.message, /^This free-plan session is not recognized\. Reconnect to the Example MCP server .* at example\.test\/signup\.$/);
  assert.equal(m.burst.message, "The Example free plan allows 20 requests every 60 seconds. Please retry in 7s, or create a free account at example.test/signup to remove this limit.");
  assert.match(m.systemConnectionWrite!.text, /^This is Example's preview account; it can't write/);
  assert.equal(m.signup, "https://example.test/signup?utm_source=free_plan&utm_medium=item_limit");
  assert.equal(m.signupBranded, "https://example.test/signup?utm_source=free_plan&utm_medium=item_limit&utm_campaign=assessments");
  assert.equal(m.monthly.signup_url, m.signup);
  assert.doesNotMatch(JSON.stringify(m), /Graffiticode|graffiticode/);
});

test("signup attribution keeps the installation's own query and fragment", async () => {
  const { signupUrlWith } = await import("../src/profile/brand.js");
  assert.equal(signupUrlWith({ utm_source: "free_plan", utm_medium: "item_limit" }, "https://example.test/signup?tenant=classroom#start"),
    "https://example.test/signup?tenant=classroom&utm_source=free_plan&utm_medium=item_limit#start");
  // A parameter the installation already sets is replaced, not duplicated.
  assert.equal(signupUrlWith({ utm_source: "free_plan" }, "https://example.test/signup?utm_source=site"), "https://example.test/signup?utm_source=free_plan");
  // Through the builder, with a profile whose signup URL has both.
  const { cpSync, mkdtempSync, readFileSync: read, writeFileSync: write } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/profile-`);
  cpSync(EXAMPLE, dir, { recursive: true });
  const p = JSON.parse(read(`${dir}/profile.json`, "utf8"));
  p.brand.links.signup = "https://example.test/signup?tenant=classroom#start";
  write(`${dir}/profile.json`, JSON.stringify(p));
  loadInstallation({ PROFILE_DIR: dir });
  assert.equal(buildSignupUrl("item_limit", "assessments"), "https://example.test/signup?tenant=classroom&utm_source=free_plan&utm_medium=item_limit&utm_campaign=assessments#start");
});
