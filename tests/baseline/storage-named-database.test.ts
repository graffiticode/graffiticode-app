// A named Firestore database (installations plan, P3, storage isolation):
// once the installation is initialized, all of core's storage, including the
// RAG analytics service created at import, uses the profile's database, and
// nothing reaches the default one.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, type Harness } from "./harness";

let h: Harness;
before(async () => { h = await start(); });
after(async () => { await h?.stop(); });

test("storage and analytics both use the profile's named database", async () => {
  // Imported first, as in production: the service exists before initialization.
  const { ragAnalytics } = await import("@graffiticode-app/core/lib/rag-analytics");
  const runtime: any = await import("@graffiticode-app/core/profile/runtime");
  const { db } = await import("@graffiticode-app/core/db");
  const { firestoreAt } = await import("@graffiticode-app/core/storage");

  const dir = mkdtempSync(join(tmpdir(), "profile-"));
  cpSync(new URL("../../packages/core/test/fixtures/installation-example", import.meta.url).pathname, dir, { recursive: true });
  const p = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8"));
  Object.assign(p.installation, { project: process.env.GOOGLE_CLOUD_PROJECT, database: "tenant-db" });
  Object.assign(p.hosts, { api: process.env.NEXT_PUBLIC_GC_API_URL, auth: process.env.NEXT_PUBLIC_GC_AUTH_URL, console: process.env.CONSOLE_URL });
  writeFileSync(join(dir, "profile.json"), JSON.stringify(p));

  const savedDir = process.env.PROFILE_DIR;
  process.env.PROFILE_DIR = dir;
  try {
    // Before initialization, storage refuses rather than picking the default database.
    assert.throws(() => db(), /isn't initialized here/);
    runtime.ensureInstallation();
    const project = process.env.GOOGLE_CLOUD_PROJECT!;
    const tenant = firestoreAt({ projectId: project, databaseId: "tenant-db" });
    const fallback = firestoreAt({ projectId: project, databaseId: "(default)" });

    await db().doc("probe/one").set({ ok: true });
    ragAnalytics.startRequest("rid-named-db", "a query", "alice");
    await ragAnalytics.completeRequest("rid-named-db", true);

    assert.equal((await tenant.doc("probe/one").get()).exists, true);
    assert.equal((await tenant.doc("rag_analytics/rid-named-db").get()).exists, true, "analytics in the named database");
    assert.equal((await fallback.doc("probe/one").get()).exists, false);
    assert.equal((await fallback.doc("rag_analytics/rid-named-db").get()).exists, false, "nothing in (default)");
  } finally {
    runtime.resetInstallation();
    if (savedDir === undefined) delete process.env.PROFILE_DIR; else process.env.PROFILE_DIR = savedDir;
  }
});
