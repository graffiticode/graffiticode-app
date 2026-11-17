// Billing and free-plan settings parity (installations plan, P2). Recorded
// from the code before these settings could come from a profile; compared
// without a profile and with the Graffiticode profile (integration gate,
// GRAFFITICODE_PROFILE_DIR). UPDATE_PARITY_SNAPSHOTS=1 re-records.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as plansConfig from "../src/lib/plans-config.js";
import * as freePlan from "../src/lib/free-plan-context.js";
import { loadInstallation, resetInstallation } from "../src/profile/runtime.js";

const SNAPSHOT = new URL("./snapshots/graffiticode-billing.json", import.meta.url).pathname;
const PROFILE = process.env.GRAFFITICODE_PROFILE_DIR ? resolve(process.env.GRAFFITICODE_PROFILE_DIR) : null;
afterEach(() => resetInstallation());

const IDS = ["demo", "starter", "pro", "teams", "platinum"] as const;
export function billingSettings() {
  const ttl = (freePlan as any).freePlanItemTtlMs?.() ?? (freePlan as any).FREE_PLAN_ITEM_TTL_MS;
  return {
    plans: Object.fromEntries([...IDS, "unknown"].map(id => [id, plansConfig.getPlan(id)])),
    included: Object.fromEntries(IDS.map(id => [id, plansConfig.includedItemsFor(id)])),
    upgrades: IDS.flatMap(a => IDS.filter(b => plansConfig.isUpgrade(a, b)).map(b => `${a}>${b}`)),
    downgrades: IDS.flatMap(a => IDS.filter(b => plansConfig.isDowngrade(a, b)).map(b => `${a}<${b}`)),
    meterEvents: Object.fromEntries(IDS.map(id => [id, plansConfig.stripeMeterEventName(id) ?? null])),
    defaultPlan: plansConfig.DEFAULT_PLAN,
    freePlanItemTtlMs: ttl,
  };
}

test("without a profile, billing and free-plan settings are unchanged", () => {
  const now = billingSettings();
  if (process.env.UPDATE_PARITY_SNAPSHOTS === "1") {
    mkdirSync(new URL("./snapshots/", import.meta.url).pathname, { recursive: true });
    writeFileSync(SNAPSHOT, JSON.stringify(now, null, 2) + "\n");
  }
  assert.deepEqual(now, JSON.parse(readFileSync(SNAPSHOT, "utf8")));
});

test("with the Graffiticode profile, billing and free-plan settings are identical", { skip: !PROFILE && "integration gate: set GRAFFITICODE_PROFILE_DIR to the Graffiticode profile" }, () => {
  assert.ok(existsSync(`${PROFILE}/profile.json`), `no profile at ${PROFILE}`);
  loadInstallation({ PROFILE_DIR: PROFILE! });
  assert.deepEqual(billingSettings(), JSON.parse(readFileSync(SNAPSHOT, "utf8")));
});

const EXAMPLE = new URL("./fixtures/installation-example", import.meta.url).pathname;
async function variant(edit: (p: any) => void) {
  const { cpSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/profile-`);
  cpSync(EXAMPLE, dir, { recursive: true });
  const p = JSON.parse(readFileSync(`${dir}/profile.json`, "utf8"));
  edit(p);
  writeFileSync(`${dir}/profile.json`, JSON.stringify(p));
  return dir;
}

test("the free-plan item lifetime is the installation's, read at use time", async () => {
  loadInstallation({ PROFILE_DIR: await variant(p => { p.freePlan = { enabled: true, itemTtlHours: 72 }; }) });
  assert.equal(freePlan.freePlanItemTtlMs(), 72 * 3_600_000);
  const { buildItemExpiredError } = await import("../src/lib/free-plan-quota.js");
  assert.match((buildItemExpiredError() as any).payload.message, /kept for 72 hours unless they're claimed/);
  resetInstallation();
  assert.equal(freePlan.freePlanItemTtlMs(), 48 * 3_600_000, "built-in again without the profile");
});

test("an installation without a free plan refuses anonymous requests", async () => {
  const { admitRequest, resolveAuth } = await import("../src/auth.js");
  const { mintSessionToken } = await import("../src/lib/free-plan-session-token.js");
  const saved = process.env.FREE_PLAN_NAMESPACE_SALT;
  process.env.FREE_PLAN_NAMESPACE_SALT = "test-salt";
  try {
    const token = await mintSessionToken({ sessionNamespace: freePlan.deriveSessionNamespace("u-1"), sessionUuid: "u-1" });
    for (const edit of [(p: any) => { p.freePlan = { enabled: false }; }, (p: any) => { delete p.freePlan; }]) {
      loadInstallation({ PROFILE_DIR: await variant(edit) });
      assert.equal(freePlan.freePlanEnabled(), false);
      await assert.rejects(admitRequest({ headers: { "x-free-plan-session": token } }), (e: any) =>
        e.code === "free_plan_disabled" && e.status === 403 && /^Example requires an account\. .* at example\.test\/signup\.$/.test(e.payload.message));
      await assert.rejects(resolveAuth({ freePlan: true, sessionNamespace: "n", sessionUuid: "u" }), (e: any) => e.code === "free_plan_disabled");
      resetInstallation();
    }
    // A signed-in caller is unaffected.
    loadInstallation({ PROFILE_DIR: await variant(p => { p.freePlan = { enabled: false }; }) });
    assert.deepEqual(await admitRequest({ headers: {} }), { freePlan: false });
  } finally {
    if (saved === undefined) delete process.env.FREE_PLAN_NAMESPACE_SALT; else process.env.FREE_PLAN_NAMESPACE_SALT = saved;
  }
});

test("a profile may restate the code's commercial terms, but not change them in this release", async () => {
  const { validateProfile } = await import("../src/profile/validate.js");
  const base = JSON.parse(readFileSync(`${EXAMPLE}/profile.json`, "utf8"));
  const restated = { ...base, billing: { plans: { pro: { displayName: "Silver", includedItems: 500, overageRatePerItem: 0.2 } } } };
  assert.deepEqual(validateProfile(restated).problems, []);
  const changed = { ...base, billing: { plans: { pro: { includedItems: 600 }, demo: { basePriceMonthly: 5 } } } };
  const problems = validateProfile(changed).problems;
  assert.ok(problems.some(x => x.path === "/billing/plans/pro/includedItems" && /different commercial terms aren't enabled in this release/.test(x.message)), JSON.stringify(problems));
  assert.ok(problems.some(x => x.path === "/billing/plans/demo/basePriceMonthly"));
  assert.equal(plansConfig.COMMERCIAL_TERMS_CONFIGURABLE, false);
});

test("plans are read through the installation at use time; tiers and Stripe wiring stay code", async () => {
  // Bypasses the validator's lock, to show the accessor would carry different terms.
  const { setInstalledProfile } = await import("../src/profile/current.js");
  const p = JSON.parse(readFileSync(`${EXAMPLE}/profile.json`, "utf8"));
  p.billing = { plans: { pro: { displayName: "Standard", includedItems: 600 } } };
  setInstalledProfile({ profile: p, digest: "terms-test" });
  try {
    const pro = plansConfig.getPlan("pro");
    assert.equal(pro.displayName, "Standard");
    assert.equal(plansConfig.includedItemsFor("pro"), 600);
    assert.equal(pro.tier, plansConfig.PLANS.pro.tier);
    assert.deepEqual(pro.stripe, plansConfig.PLANS.pro.stripe);
    assert.equal(plansConfig.isUpgrade("demo", "pro"), true);
  } finally {
    setInstalledProfile(null);
  }
  assert.equal(plansConfig.getPlan("pro").includedItems, plansConfig.PLANS.pro.includedItems);
});
