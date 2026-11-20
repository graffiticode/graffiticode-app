// The profile digest across implementations (installations plan, D-I4). A
// release's digest is computed by gc-deploy (@graffiticode/deploy,
// src/profile.js, digestOf) from the profile repository's Git objects; a
// running server's by core (profileDigest) from the directory in its image.
// gc-deploy refuses a candidate whose reported digest differs from the
// reviewed one, so the two must agree byte for byte. This fixture is a copy of
// gc-deploy's test/fixtures/profile-digest, and both tests pin the same value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileDigest } from "../src/profile/load.js";

const FIXTURE = new URL("./fixtures/profile-digest", import.meta.url).pathname;
// gc-deploy's test/profile.test.js, FIXTURE_DIGEST.
const FIXTURE_DIGEST = "9098157bd1298a9319164d698e6c9949d57b30fcc85c85c683f9451855b0f64d";

test("core's digest of the shared fixture is gc-deploy's", () => {
  // README, hidden, empty and binary files, and paths whose order depends on
  // "/" and case, all count.
  const logo = readFileSync(join(FIXTURE, "assets/logo.png"));
  assert.ok(logo.includes(0x00) && logo.includes(0xff), "the binary file has bytes that aren't text");
  assert.equal(readFileSync(join(FIXTURE, "legal/empty.txt")).length, 0);
  assert.equal(profileDigest(FIXTURE), FIXTURE_DIGEST);
});

test("dropping any one file, README.md or a hidden file included, changes the digest", () => {
  for (const file of ["README.md", ".hidden", ".well-known/mcp.json", "legal/empty.txt"]) {
    const dir = mkdtempSync(join(tmpdir(), "profile-digest-"));
    try {
      cpSync(FIXTURE, dir, { recursive: true });
      rmSync(join(dir, file));
      assert.notEqual(profileDigest(dir), FIXTURE_DIGEST, file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
