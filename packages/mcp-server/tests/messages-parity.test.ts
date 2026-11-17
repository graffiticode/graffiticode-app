// Per-message parity for response copy (installations plan, P2): the words
// tool results and refusals use to name the service, its account, free plan
// and connector. Recorded before extraction; compared without a profile, and
// with the Graffiticode profile (integration gate, GRAFFITICODE_PROFILE_DIR).
// The committed example installation always runs, to show the messages follow
// the installation. Re-record only for an intended change: UPDATE_PARITY_SNAPSHOTS=1.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { reconnectHint, buildLinkDirective } from "../src/tools.js";
import { buildFreePlanLimitText, defaultSignupUrl, FreePlanLimitError } from "../src/free-plan-limit.js";
import { catalogUnavailable } from "../src/api.js";
import { widgetResourceMeta } from "../src/widget/index.js";
import { loadInstallation, resetInstallation } from "@graffiticode-app/core/profile/runtime";

const SNAPSHOT = new URL("./snapshots/graffiticode-messages.json", import.meta.url).pathname;
const PROFILE = process.env.GRAFFITICODE_PROFILE_DIR ? resolve(process.env.GRAFFITICODE_PROFILE_DIR) : null;
const EXAMPLE = new URL("../../core/test/fixtures/installation-example", import.meta.url).pathname;
afterEach(() => resetInstallation());

function messages() {
  const out: Record<string, unknown> = {};
  for (const host of ["claude-code", "editor", "codex-cli", "claude-app", "openai", "unknown"] as const) {
    out[`reconnectHint ${host}`] = reconnectHint(host);
  }
  out["buildLinkDirective mounted"] = buildLinkDirective("https://app.example/form/x", true);
  out["buildLinkDirective unmounted"] = buildLinkDirective("https://app.example/form/x", false);
  out["freePlanLimit refusal"] = buildFreePlanLimitText(new FreePlanLimitError("language_not_in_trial_scope", "L0176 is not available."));
  out["freePlanLimit limit"] = buildFreePlanLimitText(new FreePlanLimitError("free_plan_item_limit_reached", "Limit reached.", 30));
  out["freePlanLimit limit, own signup"] = buildFreePlanLimitText(new FreePlanLimitError("free_plan_daily_limit_reached", "Daily.", undefined, "https://signup.example/x"));
  out["catalogUnavailable"] = catalogUnavailable(new Error("timeout")).message;
  out["widgetDescription"] = widgetResourceMeta()["openai/widgetDescription"];
  return out;
}

test("without a profile, every message is unchanged", () => {
  const now = messages();
  if (process.env.UPDATE_PARITY_SNAPSHOTS === "1") {
    mkdirSync(new URL("./snapshots/", import.meta.url).pathname, { recursive: true });
    writeFileSync(SNAPSHOT, JSON.stringify(now, null, 2) + "\n");
  }
  assert.deepEqual(now, JSON.parse(readFileSync(SNAPSHOT, "utf8")));
});

test("with the Graffiticode profile, every message is byte-identical", { skip: !PROFILE && "integration gate: set GRAFFITICODE_PROFILE_DIR to the Graffiticode profile" }, () => {
  assert.ok(existsSync(`${PROFILE}/profile.json`), `no profile at ${PROFILE}`);
  loadInstallation({ PROFILE_DIR: PROFILE! });
  assert.deepEqual(messages(), JSON.parse(readFileSync(SNAPSHOT, "utf8")));
});

test("with the example installation, messages name it, not Graffiticode", () => {
  loadInstallation({ PROFILE_DIR: EXAMPLE });
  const m = messages() as Record<string, string>;
  assert.equal(m["reconnectHint claude-code"], "After signing in, connect this account: claude mcp add --transport http example https://mcp.example.test/mcp --header \"Authorization: Bearer <api-key>\" — the sign-in page issues the key.");
  assert.match(m["reconnectHint editor"], /the example entry in your MCP config/);
  assert.match(m["reconnectHint codex-cli"], /run codex mcp login example /);
  assert.match(m["reconnectHint claude-app"], /disconnect Example and connect it again/);
  assert.match(m["buildLinkDirective mounted"], /displayed above in the Example view/);
  assert.match(m["freePlanLimit refusal"], /^Example rejected this request: /);
  assert.match(m["freePlanLimit limit"], /\*\*Example free-plan limit reached\*\*/);
  assert.match(m["freePlanLimit limit"], /\[Create a free Example account\]\(https:\/\/example\.test\/signup\?utm_source=free_plan&utm_medium=mcp\)/);
  assert.match(m["freePlanLimit limit, own signup"], /\(https:\/\/signup\.example\/x\)/);
  assert.match(m["catalogUnavailable"], /^The Example language catalog is temporarily unavailable/);
  assert.match(m["catalogUnavailable"], /tell the user Example can't be reached/);
  assert.match(m["widgetDescription"], /^Shows the Example item itself/);
  for (const [k, v] of Object.entries(m)) assert.doesNotMatch(v, /Graffiticode|graffiticode/, k);
});

test("the MCP signup link keeps the installation's own query and fragment", async () => {
  const { cpSync, mkdtempSync, readFileSync: read, writeFileSync: write } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/profile-`);
  cpSync(EXAMPLE, dir, { recursive: true });
  const p = JSON.parse(read(`${dir}/profile.json`, "utf8"));
  p.brand.links.signup = "https://example.test/signup?tenant=classroom#start";
  write(`${dir}/profile.json`, JSON.stringify(p));
  loadInstallation({ PROFILE_DIR: dir });
  assert.equal(defaultSignupUrl(), "https://example.test/signup?tenant=classroom&utm_source=free_plan&utm_medium=mcp#start");
});
