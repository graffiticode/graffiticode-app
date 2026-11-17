// Installation profiles (installations plan, P1): schema, consistency, the
// capability registry, referenced files, and the digest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, profileDigest, profileReceipt, ProfileError } from "../src/profile/load.js";
import { validateProfile } from "../src/profile/validate.js";
import { capability, capabilityRefusal } from "../src/capabilities.js";

const FIXTURE = new URL("./fixtures/profile-valid", import.meta.url).pathname;

// A fresh copy of the valid fixture, with `edit` applied to its profile.json.
function profileDir(edit: (p: any) => void = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "profile-"));
  cpSync(FIXTURE, dir, { recursive: true });
  const p = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8"));
  edit(p);
  writeFileSync(join(dir, "profile.json"), JSON.stringify(p, null, 2));
  return dir;
}

const problemsOf = (dir: string) => {
  try {
    loadProfile(dir);
    return [];
  } catch (err) {
    assert.ok(err instanceof ProfileError, String(err));
    return (err as ProfileError).problems;
  }
};
const has = (problems: { path: string; message: string }[], path: string, re: RegExp) =>
  problems.some(p => p.path === path && re.test(p.message));

test("the valid fixture loads, with a digest", () => {
  const loaded = loadProfile(profileDir());
  assert.equal(loaded.profile.installation.id, "example");
  assert.match(loaded.digest, /^[0-9a-f]{64}$/);
  assert.equal(loaded.readText("copy/instructions.md").trim(), "Use the tools to make things.");
});

test("an unsupported profile version is refused before anything else", () => {
  const problems = problemsOf(profileDir(p => { p.profileVersion = 2; }));
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /unsupported profile version 2/);
});

test("schema violations are reported together", () => {
  const problems = problemsOf(profileDir(p => {
    delete p.hosts.mcp;
    p.installation.id = "Not An Id";
    p.unexpected = true;
  }));
  assert.ok(has(problems, "/hosts", /required property 'mcp'/), JSON.stringify(problems));
  assert.ok(has(problems, "/installation/id", /pattern/));
  assert.ok(has(problems, "/", /additional properties \(unexpected\)/));
});

test("a missing asset or document is refused", () => {
  const dir = profileDir();
  rmSync(join(dir, "legal/terms.md"));
  rmSync(join(dir, "assets/logo.svg"));
  const problems = problemsOf(dir);
  assert.ok(has(problems, "/brand/legal/terms", /file not found/));
  assert.ok(has(problems, "/brand/assets/logo", /file not found/));
});

test("a referenced file can't leave the profile directory", () => {
  assert.ok(has(problemsOf(profileDir(p => { p.brand.legal.terms = "../outside.md"; })), "/brand/legal/terms", /pattern/));
});

test("symlinks are refused anywhere in a profile, even pointing inside it", () => {
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  writeFileSync(join(outside, "terms.md"), "# not ours\n");
  const out = profileDir();
  rmSync(join(out, "legal/terms.md"));
  symlinkSync(join(outside, "terms.md"), join(out, "legal/terms.md"));
  assert.ok(has(problemsOf(out), "/legal/terms.md", /symlinks aren't supported/));

  const internal = profileDir();
  symlinkSync(join(internal, "legal/privacy.md"), join(internal, "legal/alias.md"));
  assert.ok(has(problemsOf(internal), "/legal/alias.md", /symlinks aren't supported/));
  assert.throws(() => profileDigest(internal), /symlinks aren't supported/);
});

test("profile.json itself must be a regular file inside the profile", () => {
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  const dir = profileDir();
  cpSync(join(dir, "profile.json"), join(outside, "profile.json"));
  rmSync(join(dir, "profile.json"));
  symlinkSync(join(outside, "profile.json"), join(dir, "profile.json"));
  assert.ok(has(problemsOf(dir), "/profile.json", /symlinks aren't supported/));
});

test("hidden files are part of the profile: referenceable, and covered by the digest", () => {
  const dir = profileDir(p => { p.copy.instructions = ".copy/instructions.md"; });
  mkdirSync(join(dir, ".copy"));
  writeFileSync(join(dir, ".copy/instructions.md"), "hidden instructions\n");
  const loaded = loadProfile(dir);
  assert.equal(loaded.readText(".copy/instructions.md"), "hidden instructions\n");
  writeFileSync(join(dir, ".copy/instructions.md"), "changed\n");
  assert.notEqual(profileDigest(dir), loaded.digest);
});

test("a .git directory is neither hashed nor referenceable", () => {
  const dir = profileDir();
  const before = profileDigest(dir);
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, ".git/HEAD"), "ref: refs/heads/main\n");
  assert.equal(profileDigest(dir), before);
  const ref = profileDir(p => { p.copy.instructions = ".git/HEAD"; });
  mkdirSync(join(ref, ".git"));
  writeFileSync(join(ref, ".git/HEAD"), "x\n");
  assert.ok(has(problemsOf(ref), "/copy/instructions", /file not found/));
});

test("different layouts never produce the same digest", () => {
  // Under a delimiter encoding, path\0content\0, these two layouts hash the
  // same bytes: x = "y\0z\0w"; versus x = "y" and z = "w".
  const a = mkdtempSync(join(tmpdir(), "layout-"));
  writeFileSync(join(a, "x"), Buffer.from("y\0z\0w"));
  const b = mkdtempSync(join(tmpdir(), "layout-"));
  writeFileSync(join(b, "x"), "y");
  writeFileSync(join(b, "z"), "w");
  assert.notEqual(profileDigest(a), profileDigest(b));
});

test("a skill can't select an unknown capability", () => {
  const problems = problemsOf(profileDir(p => { p.services[0].skills[0].capability = "teleport"; }));
  assert.ok(has(problems, "/services/0/skills/0/capability", /unknown capability teleport/));
});

test("a profile can't make an unfinished or writing capability available", () => {
  // save-revision is unimplemented, writes externally and needs execution:
  // nothing a profile says changes that.
  const problems = problemsOf(profileDir(p => {
    Object.assign(p.services[0].skills[0], { capability: "save-revision", deliveryStates: ["saved"] });
  }));
  assert.ok(has(problems, "/services/0/skills/0/capability", /save-revision can't be selected: not implemented/));
  // The facts are code's: the registry says what it says.
  const save = capability("save-revision")!;
  assert.equal(save.externalWrites, true);
  assert.equal(capabilityRefusal(save), "not implemented in this release");
  // Even once implemented, a writing capability waits for execution.
  assert.match(String(capabilityRefusal({ ...save, implemented: true })), /needs backend execution/);
  assert.equal(capabilityRefusal({ ...save, implemented: true }, { executionReady: true }), null);
});

test("a skill must ask for a deliverable its capability produces", () => {
  const problems = problemsOf(profileDir(p => {
    Object.assign(p.services[0].skills[1], { deliverableKind: "operation_result", deliveryStates: ["applied"] });
    p.services[0].skills[0].deliveryStates = ["prepared", "saved"];
  }));
  assert.ok(has(problems, "/services/0/skills/1/deliverableKind", /doesn't deliver operation_result/));
  assert.ok(has(problems, "/services/0/skills/0/deliveryStates", /can't deliver content as saved/));
});

test("skill ids never encode a language number; languages must be in the catalog", () => {
  assert.ok(has(problemsOf(profileDir(p => { p.services[0].skills[0].skillId = "author_l0176"; })), "/services/0/skills/0/skillId", /pattern/));
  assert.ok(has(problemsOf(profileDir(p => { p.services[0].skills[0].languages = ["0180"]; })), "/services/0/skills/0/languages", /isn't in this installation's catalog/));
});

test("duplicates and dangling references inside a profile are refused", () => {
  const problems = problemsOf(profileDir(p => {
    p.services.push(structuredClone(p.services[0]));
    p.services[0].skills[1].skillId = p.services[0].skills[0].skillId;
    p.surfaces.mcp.push({ path: "/mcp", families: ["items"], services: ["assessment-authoring"] });
    p.surfaces.mcp[1].services = ["nope"];
  }));
  assert.ok(has(problems, "/services/1/serviceId", /duplicate service/));
  assert.ok(has(problems, "/services/0/skills/1/skillId", /duplicate skill/));
  assert.ok(has(problems, "/surfaces/mcp/2/path", /duplicate path/));
  assert.ok(has(problems, "/surfaces/mcp/2/services", /need the "services" family/));
  assert.ok(has(problems, "/surfaces/mcp/1/services", /unknown service nope/));
});

test("a services surface needs services; resources must be on the installation's hosts", () => {
  const problems = problemsOf(profileDir(p => {
    p.services = [];
    p.surfaces.mcp[1].services = undefined;
    p.auth.resources.mcp = "https://mcp.graffiticode.org/mcp";
  }));
  assert.ok(has(problems, "/surfaces/mcp/1/families", /needs at least one service/));
  assert.ok(has(problems, "/auth/resources/mcp", /must be on the installation's mcp host/));
});

test("resources are compared by exact origin, not by string prefix", () => {
  const prefix = problemsOf(profileDir(p => { p.auth.resources.openapi = "https://openapi.example.test.other.test/v1"; }));
  assert.ok(has(prefix, "/auth/resources/openapi", /must be on the installation's openapi host/));
  const userinfo = problemsOf(profileDir(p => { p.auth.resources.mcp = "https://mcp.example.test@evil.test/mcp"; }));
  assert.ok(has(userinfo, "/auth/resources/mcp", /must be on the installation's mcp host/));
  const port = problemsOf(profileDir(p => { p.auth.resources.mcp = "https://mcp.example.test:8443/mcp"; }));
  assert.ok(has(port, "/auth/resources/mcp", /must be on the installation's mcp host/));
});

test("the digest covers every file, so any change to the profile changes it", () => {
  const dir = profileDir();
  const before = profileDigest(dir);
  assert.equal(profileDigest(dir), before, "stable");
  writeFileSync(join(dir, "legal/privacy.md"), "# Privacy, revised\n");
  assert.notEqual(profileDigest(dir), before);
});

test("a release receipt records the app and the profile together", () => {
  const loaded = loadProfile(profileDir());
  assert.deepEqual(profileReceipt(loaded, { appVersion: "abc123", profileRepo: "example/installation", profileRef: "v1" }), {
    appVersion: "abc123", installationId: "example", profileVersion: 1,
    profileRepo: "example/installation", profileRef: "v1", profileDigest: loaded.digest,
  });
});

test("validateProfile works without file access, for tools that only check structure", () => {
  const raw = JSON.parse(readFileSync(join(FIXTURE, "profile.json"), "utf8"));
  assert.equal(validateProfile(raw).ok, true);
});

test("catalog policy names only known languages, and only offered ones", () => {
  const problems = problemsOf(profileDir(p => {
    p.catalog = { languages: ["0176", "0178", "9999"], hidden: ["0180"], sponsors: { "0184": { name: "S" } } };
    p.freePlan = { enabled: true, languages: ["0179"] };
  }));
  assert.ok(has(problems, "/catalog/languages", /unknown language L9999/), JSON.stringify(problems));
  assert.ok(has(problems, "/catalog/hidden", /L0180 isn't offered/));
  assert.ok(has(problems, "/catalog/sponsors", /L0184 isn't offered/));
  assert.ok(has(problems, "/freePlan/languages", /L0179 isn't offered/));
});
