// Initializing an installation in a server process (installations plan, P2,
// console loading): fail closed, initialize once, pin for the process's life.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureInstallation, resetInstallation, profile } from "../src/profile/runtime.js";
import { installedProfile } from "../src/profile/current.js";
import { findLanguageById, listLanguages } from "../src/lib/languages.js";

const EXAMPLE = new URL("./fixtures/installation-example", import.meta.url).pathname;
const copyOf = () => { const d = mkdtempSync(join(tmpdir(), "profile-")); cpSync(EXAMPLE, d, { recursive: true }); return d; };
afterEach(() => { resetInstallation(); delete process.env.PROFILE_DIR; });

test("with PROFILE_DIR set and nothing installed, policy reads fail closed", async () => {
  process.env.PROFILE_DIR = EXAMPLE;
  assert.throws(() => installedProfile(), /PROFILE_DIR is set, but no installation profile is installed here/);
  assert.throws(() => findLanguageById("0180"), /no installation profile is installed/);
  await assert.rejects(listLanguages({}), /no installation profile is installed/);
});

test("ensureInstallation loads once and pins the profile for the process", () => {
  const dir = copyOf();
  const first = ensureInstallation({ PROFILE_DIR: dir } as any)!;
  assert.equal(first.installationId, "example");
  // Changing the files doesn't reload them: the second call reuses the pinned profile.
  writeFileSync(join(dir, "legal/terms.html"), "<p>changed</p>\n");
  const second = ensureInstallation({ PROFILE_DIR: dir } as any)!;
  assert.equal(second.profileDigest, first.profileDigest);
  assert.equal(profile()!.installation.id, "example");
  // A different PROFILE_DIR later is refused, not silently ignored.
  assert.throws(() => ensureInstallation({ PROFILE_DIR: copyOf() } as any), /Restart to change installations/);
});

test("a profile that fails to load leaves nothing installed, so reads keep failing closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "profile-"));
  writeFileSync(join(dir, "profile.json"), JSON.stringify({ profileVersion: 1 }));
  process.env.PROFILE_DIR = dir;
  assert.throws(() => ensureInstallation(), /Invalid installation profile/);
  assert.throws(() => installedProfile(), /no installation profile is installed/);
});

test("without PROFILE_DIR there is nothing to load, and built-in policy applies", () => {
  assert.equal(ensureInstallation({} as any), null);
  assert.equal(installedProfile(), null);
  assert.ok(findLanguageById("0180"));
});

test("separate module instances of core share the process's installation", async () => {
  // A bundler can give each server bundle its own copy of core; simulate two.
  const a = await import("../src/profile/runtime.ts?instance=a");
  const b = await import("../src/profile/runtime.ts?instance=b");
  const currentB = await import("../src/profile/current.ts?instance=b");
  assert.notEqual(a.loadInstallation, b.loadInstallation, "two module instances");
  const receipt = a.ensureInstallation({ PROFILE_DIR: EXAMPLE } as any)!;
  assert.deepEqual(b.installationReceipt(), receipt);
  assert.equal(b.profile()!.installation.id, "example");
  assert.equal(currentB.installedProfile()!.digest, receipt.profileDigest);
  // Initializing again from the other instance reuses the pinned profile.
  assert.deepEqual(b.ensureInstallation({ PROFILE_DIR: EXAMPLE } as any), receipt);
  b.resetInstallation();
  assert.equal(a.profile(), null);
});
