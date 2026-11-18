// REST without a free plan (installations plan, P2): no workspaces are
// issued, and an existing workspace token gets the account-required refusal
// with its sign-in link, never "start another workspace".
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { loadInstallation, resetInstallation } from "@graffiticode-app/core/profile/runtime";
import { mintSessionToken } from "@graffiticode-app/core/lib/free-plan-session-token";
import { deriveSessionNamespace } from "@graffiticode-app/core/lib/free-plan-context";

const EXAMPLE = new URL("../../core/test/fixtures/installation-example", import.meta.url).pathname;
const savedSalt = process.env.FREE_PLAN_NAMESPACE_SALT;
before(() => { process.env.FREE_PLAN_NAMESPACE_SALT = "test-salt"; });
after(() => { if (savedSalt === undefined) delete process.env.FREE_PLAN_NAMESPACE_SALT; else process.env.FREE_PLAN_NAMESPACE_SALT = savedSalt; });
afterEach(() => resetInstallation());

function install(freePlan: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "profile-"));
  cpSync(EXAMPLE, dir, { recursive: true });
  const p = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8"));
  p.freePlan = freePlan;
  writeFileSync(join(dir, "profile.json"), JSON.stringify(p));
  loadInstallation({ PROFILE_DIR: dir });
}

const disabled = (body: any) => {
  assert.equal(body.code, "free_plan_disabled");
  assert.match(body.detail, /^Example requires an account\. .* at example\.test\/signup\.$/);
  assert.equal(body.signup_url, "https://example.test/signup?utm_source=free_plan&utm_medium=free_plan_disabled");
  assert.doesNotMatch(JSON.stringify(body), /POST \/workspaces/);
};

test("no workspace is issued where there is no free plan", async () => {
  install({ enabled: false });
  const r = await createApp().request("http://x/v1/workspaces", { method: "POST" });
  assert.equal(r.status, 403);
  assert.match(r.headers.get("content-type")!, /application\/problem\+json/);
  disabled(await r.json());
});

test("an existing workspace token gets the account-required refusal, not workspace_invalid", async () => {
  install({ enabled: false });
  const token = await mintSessionToken({ sessionNamespace: deriveSessionNamespace("w-1"), sessionUuid: "w-1" });
  const r = await createApp().request("http://x/v1/me", { headers: { "x-graffiticode-workspace": token } });
  assert.equal(r.status, 403);
  disabled(await r.json());
});
