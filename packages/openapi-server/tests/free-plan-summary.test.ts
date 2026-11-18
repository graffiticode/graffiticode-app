// The free-plan summary /me returns (installations plan, P2, free-plan
// settings): recorded before the settings moved to the profile.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { freePlanSummary } from "../src/routes/account.ts";
import { resetInstallation } from "@graffiticode-app/core/profile/runtime";

const SNAPSHOT = new URL("./snapshots/graffiticode-free-plan.json", import.meta.url).pathname;
afterEach(() => resetInstallation());

test("without a profile, the free-plan summary keeps every field it had", () => {
  const now = freePlanSummary() as Record<string, unknown>;
  if (process.env.UPDATE_PARITY_SNAPSHOTS === "1") {
    mkdirSync(new URL("./snapshots/", import.meta.url).pathname, { recursive: true });
    writeFileSync(SNAPSHOT, JSON.stringify(now, null, 2) + "\n");
  }
  const before = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  for (const k of Object.keys(before)) assert.deepEqual(now[k], before[k], k);
});

test("the summary is the installation's: lifetime, and whether languages are restricted", async () => {
  const { cpSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { loadInstallation } = await import("@graffiticode-app/core/profile/runtime");
  const EXAMPLE = new URL("../../core/test/fixtures/installation-example", import.meta.url).pathname;
  const variant = (freePlan: unknown) => {
    const dir = mkdtempSync(`${tmpdir()}/profile-`);
    cpSync(EXAMPLE, dir, { recursive: true });
    const p = JSON.parse(readFileSync(`${dir}/profile.json`, "utf8"));
    p.freePlan = freePlan;
    p.catalog = { languages: ["0179", "0180"] };
    writeFileSync(`${dir}/profile.json`, JSON.stringify(p));
    return dir;
  };
  loadInstallation({ PROFILE_DIR: variant({ enabled: true, itemTtlHours: 72 }) });
  assert.deepEqual(freePlanSummary(), { item_ttl_hours: 72, languages: [], languages_restricted: false, signup_url: "https://example.test/signup" });
  resetInstallation();
  loadInstallation({ PROFILE_DIR: variant({ enabled: true, languages: [] }) });
  assert.deepEqual(freePlanSummary(), { item_ttl_hours: 48, languages: [], languages_restricted: true, signup_url: "https://example.test/signup" });
  resetInstallation();
  loadInstallation({ PROFILE_DIR: variant({ enabled: true, languages: ["0180"] }) });
  assert.equal((freePlanSummary() as any).languages_restricted, true);
  assert.deepEqual(freePlanSummary().languages, ["L0180"]);
});
