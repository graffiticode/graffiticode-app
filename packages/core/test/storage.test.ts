// Installation storage isolation (installations plan, P3, slice 1): where an
// installation's application data lives is explicit, and only one module makes
// a Firestore handle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveStorage, StorageConfigError } from "../src/profile/storage-config.js";

const EXAMPLE = JSON.parse(readFileSync(new URL("./fixtures/installation-example/profile.json", import.meta.url), "utf8"));
const REPO = new URL("../../../", import.meta.url).pathname;

test("with a profile, its project and database; the environment may repeat but not contradict them", () => {
  assert.deepEqual(resolveStorage(EXAMPLE, {}), { projectId: "example-installation", databaseId: "(default)" });
  const named = structuredClone(EXAMPLE); named.installation.database = "example-db";
  assert.deepEqual(resolveStorage(named, { GOOGLE_CLOUD_PROJECT: "example-installation", FIRESTORE_DATABASE_ID: "example-db" }), { projectId: "example-installation", databaseId: "example-db" });
  assert.throws(() => resolveStorage(EXAMPLE, { GOOGLE_CLOUD_PROJECT: "graffiticode-app" }), (e: any) => e instanceof StorageConfigError && /GOOGLE_CLOUD_PROJECT=graffiticode-app contradicts the installation profile's project/.test(e.message));
  assert.throws(() => resolveStorage(EXAMPLE, { GCLOUD_PROJECT: "other" }), /GCLOUD_PROJECT=other contradicts/);
  assert.throws(() => resolveStorage(named, { FIRESTORE_DATABASE_ID: "(default)" }), /FIRESTORE_DATABASE_ID=\(default\) contradicts the installation profile's database \(example-db\)/);
});

test("without a profile, the project is required: there is no built-in one", () => {
  assert.throws(() => resolveStorage(null, {}), /GOOGLE_CLOUD_PROJECT is required: there is no built-in project/);
  assert.deepEqual(resolveStorage(null, { GOOGLE_CLOUD_PROJECT: "p-1" }), { projectId: "p-1", databaseId: "(default)" });
  assert.deepEqual(resolveStorage(null, { GCLOUD_PROJECT: "p-1", FIRESTORE_DATABASE_ID: "named" }), { projectId: "p-1", databaseId: "named" });
  assert.throws(() => resolveStorage(null, { GOOGLE_CLOUD_PROJECT: "a", GCLOUD_PROJECT: "b" }), /disagree/);
});

// Server source only: browser code uses the Firebase client SDK ("firebase/..."),
// which belongs to the shared authentication project, not application storage.
const SERVER_SOURCES = ["packages/core/src", "packages/console/src", "packages/mcp-server/src", "packages/openapi-server/src", "packages/app/src"];
const ALLOWED = new Set(["packages/core/src/storage.ts"]);
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(REPO, dir))) {
    const rel = join(dir, name);
    if (statSync(join(REPO, rel)).isDirectory()) out.push(...sources(rel));
    else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(rel);
  }
  return out;
}

test("only core/src/storage.ts creates a Firebase Admin app or a Firestore handle", () => {
  const offenders: string[] = [];
  for (const dir of SERVER_SOURCES) {
    for (const file of sources(dir)) {
      if (ALLOWED.has(file)) continue;
      const text = readFileSync(join(REPO, file), "utf8");
      const usesAdmin = /from ["']firebase-admin(\/firestore)?["']/.test(text);
      if (!usesAdmin) continue;
      if (/\binitializeApp\s*\(/.test(text) || /\badmin\.firestore\(\)/.test(text) ||
          /import\s*\{[^}]*\bgetFirestore\b[^}]*\}\s*from\s*["']firebase-admin\/firestore["']/.test(text)) {
        offenders.push(file);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("installation handles drop undefined fields instead of rejecting the write", async () => {
  const { firestoreAt } = await import("../src/storage.js");
  const db = firestoreAt({ projectId: "storage-test-undefined", databaseId: "(default)" });
  assert.equal((db as any)._settings?.ignoreUndefinedProperties, true);
});

test("deploy.json states every service's project", () => {
  const deploy = JSON.parse(readFileSync(join(REPO, "deploy.json"), "utf8"));
  const project = deploy.environments.production.project;
  for (const [name, svc] of Object.entries<any>(deploy.services)) {
    assert.equal(svc.env?.GOOGLE_CLOUD_PROJECT, project, name);
  }
});
