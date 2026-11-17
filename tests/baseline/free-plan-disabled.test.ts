// An installation without a free plan (installations plan, P2, billing and
// free-plan settings): anonymous requests are refused on every path, and
// readiness doesn't require trial credentials it will never use.
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, type Harness } from "./harness";

let h: Harness;
let runtime: any;
let token = "";
const saved: Record<string, string | undefined> = {};
before(async () => {
  h = await start();
  runtime = await import("@graffiticode-app/core/profile/runtime");
  const { mintSessionToken } = await import("@graffiticode-app/core/lib/free-plan-session-token");
  const { deriveSessionNamespace } = await import("@graffiticode-app/core/lib/free-plan-context");
  token = await mintSessionToken({ sessionNamespace: deriveSessionNamespace("disabled-1"), sessionUuid: "disabled-1" });
  // Without trial credentials, reaching their lookup is a visible 500.
  for (const k of ["FREE_PLAN_API_KEY", "FREE_PLAN_UID"]) { saved[k] = process.env[k]; delete process.env[k]; }
});
after(async () => {
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  await h?.stop();
});
afterEach(() => runtime.resetInstallation());

// The example installation, on the harness's hosts, with this free-plan setting.
function install(freePlan: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "profile-"));
  cpSync(new URL("../../packages/core/test/fixtures/installation-example", import.meta.url).pathname, dir, { recursive: true });
  const p = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8"));
  p.hosts.api = process.env.NEXT_PUBLIC_GC_API_URL;
  p.hosts.auth = process.env.NEXT_PUBLIC_GC_AUTH_URL;
  p.hosts.console = process.env.CONSOLE_URL;
  // The harness's storage: the profile states the same project.
  p.installation.project = process.env.GOOGLE_CLOUD_PROJECT;
  if (freePlan === undefined) delete p.freePlan; else p.freePlan = freePlan;
  writeFileSync(join(dir, "profile.json"), JSON.stringify(p));
  runtime.loadInstallation({ ...process.env, PROFILE_DIR: dir });
}

async function compile(headers: Record<string, string>) {
  const { default: handler } = await import("../../packages/console/src/pages/api/compile");
  let status = 0, body: any = null;
  const res: any = {
    setHeader() {}, end() { return res; },
    status(s: number) { status = s; return res; },
    json(b: unknown) { body = b; return res; },
  };
  await handler({ method: "POST", headers, body: { item: {} } } as any, res);
  return { status, body };
}

test("readiness requires trial credentials only where anonymous use is allowed", async () => {
  const { coreReadiness } = await import("@graffiticode-app/core/readiness");
  install({ enabled: false });
  assert.equal((await coreReadiness({ queue: false })).checks.freePlan, undefined);
  runtime.resetInstallation();
  install(undefined);
  assert.equal((await coreReadiness({ queue: false })).checks.freePlan, undefined, "no freePlan section: no free plan");
  runtime.resetInstallation();
  install({ enabled: true });
  assert.notEqual((await coreReadiness({ queue: false })).checks.freePlan, "ok", "enabled: the missing credentials fail readiness");
});

test("the compile proxy refuses anonymous compiles before burst accounting or credential lookup", async () => {
  install({ enabled: false });
  const refused = await compile({ "x-free-plan-session": token });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, "free_plan_disabled");
  assert.match(refused.body.message, /requires an account/);
  const burst = await h.db.collection("free-plan-state").doc("sessions").listCollections();
  assert.deepEqual(burst.map((c: any) => c.id), [], "no burst hit recorded");
  // Enabled, the proxy still applies the compile burst limit, then looks up
  // the trial credentials (absent here, so 500).
  runtime.resetInstallation();
  install({ enabled: true });
  const allowed = await compile({ "x-free-plan-session": token });
  assert.equal(allowed.status, 500);
  assert.equal(allowed.body.error, "free_plan_misconfigured");
  const hits = await h.db.collection("free-plan-state").doc("sessions").listCollections();
  assert.equal(hits.length, 1, "the compile burst hit was recorded");
  assert.ok((await hits[0].doc("burst-compile").get()).exists);
});
