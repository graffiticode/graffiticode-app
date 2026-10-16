// Phase 4c: free-plan workspaces, /me, and Idempotency-Key on the POSTs that
// start a generation (the Phase 3.5 protocol: claimed -> bound -> completed).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { start, userToken, type Harness } from "./harness";

let h: Harness;
let app: any;
let protocol: any;
let jobs: any;
let idem: any;
before(async () => {
  h = await start();
  process.env.GRAFFITICODE_CONSOLE_URL = `${h.consoleOrigin}/api`;
  process.env.OPENAPI_PUBLIC_URL = "https://openapi.test/v1";
  protocol = await import("@graffiticode-app/core/generation-protocol");
  jobs = await import("@graffiticode-app/core/generation-jobs");
  idem = await import("@graffiticode-app/core/idempotency");
  app = (await import("../../packages/openapi-server/src/app.ts")).createApp();
});
after(async () => { await h?.stop(); });
beforeEach(async () => {
  await h.resetFirestore();
  await h.db.doc("system/generation-protocol").set({ minProtocol: 2 });
  protocol.resetProtocolFloorCache();
});

const PROGRAM = readFileSync(new URL("../../node_modules/@graffiticode/l0175/dist/static/template.gc", import.meta.url), "utf8");
const DESCRIPTION = "Write a short literary passage about a lighthouse keeper.";
const alice = { Authorization: `Bearer ${userToken("alice")}` };
const call = (method: string, path: string, headers: Record<string, string> = {}, raw?: string) =>
  app.request(`http://x/v1${path}`, { method, headers: { ...(raw !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, ...(raw !== undefined ? { body: raw } : {}) });
const createRaw = JSON.stringify({ language: "L0175", description: DESCRIPTION });
const jobCount = async () => (await h.db.collection("generation-jobs").get()).size;

test("POST /workspaces starts a free-plan workspace that can make items; /me describes it", async () => {
  const res = await call("POST", "/workspaces");
  assert.equal(res.status, 201);
  const { workspace, expires_at } = await res.json();
  assert.equal(workspace.split(".").length, 3);
  assert.ok(Date.parse(expires_at) > Date.now() + 47 * 3600_000);
  const ws = { "X-Graffiticode-Workspace": workspace };
  const created = await call("POST", "/items", ws, createRaw);
  assert.equal(created.status, 202);
  await h.drainJobs();
  const me = await (await call("GET", "/me", ws)).json();
  assert.equal(me.account, "free_plan");
  assert.equal(me.free_plan.item_ttl_hours, 48);
  assert.ok(me.free_plan.languages.every((l: string) => /^L\d{4}$/.test(l)));
});

test("/me for an account: its plan and this period's usage", async () => {
  await call("POST", "/items", alice, createRaw);
  await h.drainJobs();
  const me = await (await call("GET", "/me", alice)).json();
  assert.equal(me.account, "user");
  assert.ok(me.plan.id && me.plan.name);
  assert.equal(me.usage.items_this_period, 1);
  assert.equal((await call("GET", "/me")).status, 401);
});

test("the same Idempotency-Key replays the original response: one item, one job", async () => {
  const key = { ...alice, "Idempotency-Key": "create-1" };
  const first = await call("POST", "/items", key, createRaw);
  assert.equal(first.status, 202);
  const a = await first.json();
  await h.drainJobs();
  const again = await call("POST", "/items", key, createRaw);
  assert.equal(again.status, 202);
  assert.equal(again.headers.get("idempotent-replayed"), "true");
  assert.equal(again.headers.get("location"), first.headers.get("location"));
  assert.equal((await again.json()).id, a.id);
  assert.equal(await jobCount(), 1);
  assert.equal((await call("POST", "/items", alice, createRaw)).status, 202, "no key: a second item");
  assert.equal(await jobCount(), 2);
  await h.drainJobs();
});

test("a key reused for a different request is 422; one still in flight is 409", async () => {
  const key = { ...alice, "Idempotency-Key": "k-2" };
  assert.equal((await call("POST", "/items", key, createRaw)).status, 202);
  await h.drainJobs();
  const other = await call("POST", "/items", key, JSON.stringify({ language: "L0175", description: "Something else entirely, please." }));
  assert.equal(other.status, 422);
  assert.equal((await other.json()).code, "idempotency_key_reused");

  // A claim another request holds right now (claimed moments ago, nothing bound yet).
  const fingerprint = createHash("sha256").update(`POST /v1/items\n${createRaw}`).digest("hex");
  await idem.idempotencyRef("uid:alice", "k-3").set({ fingerprint, state: "claimed", claimToken: "other", claimedAt: Date.now(), expiresAt: new Date(Date.now() + 3600_000) });
  const busy = await call("POST", "/items", { ...alice, "Idempotency-Key": "k-3" }, createRaw);
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).code, "idempotency_key_in_use");
  assert.equal(busy.headers.get("retry-after"), "2");
  assert.equal(await jobCount(), 1);
});

test("a refused request releases its key, so the same request can be retried", async () => {
  const { id } = await (await call("POST", "/items", alice, createRaw)).json();
  await h.drainJobs();
  h.setLlm(() => "```\n" + PROGRAM.replace(/"[^"]*"/, '"Winter"') + "\n```", 600);
  assert.equal((await call("POST", `/items/${id}/revisions`, alice, JSON.stringify({ modification: "Make it winter." }))).status, 202);
  const revise = JSON.stringify({ modification: "Make it summer." });
  const key = { ...alice, "Idempotency-Key": "rev-1" };
  assert.equal((await call("POST", `/items/${id}/revisions`, key, revise)).status, 409, "still generating");
  await h.drainJobs();
  const retried = await call("POST", `/items/${id}/revisions`, key, revise);
  assert.equal(retried.status, 202);
  assert.equal(retried.headers.get("idempotent-replayed"), null, "it ran this time");
  await h.drainJobs();
});

test("a key bound to a job whose request never answered is rebuilt, not run again", async () => {
  // The original request: claimed and reserved (bound), then the process died.
  const fingerprint = createHash("sha256").update(`POST /v1/items\n${createRaw}`).digest("hex");
  const claim = await idem.claimIdempotencyKey({ scope: "uid:alice", key: "crash-1", fingerprint });
  assert.equal(claim.kind, "claimed");
  const reserved = await jobs.reserveGeneration({
    auth: { uid: "alice", token: userToken("alice") }, lang: "0175", prompt: DESCRIPTION, modification: DESCRIPTION,
    idempotency: { ref: claim.ref, claimToken: claim.claimToken },
  });
  await h.drainJobs();
  assert.equal((await claim.ref.get()).data().state, "bound");

  const res = await call("POST", "/items", { ...alice, "Idempotency-Key": "crash-1" }, createRaw);
  assert.equal(res.status, 202);
  assert.equal(res.headers.get("idempotent-replayed"), "true");
  assert.equal((await res.json()).id, reserved.itemId);
  assert.equal(await jobCount(), 1, "nothing reserved again");
  assert.equal((await claim.ref.get()).data().state, "completed");
});

test("Idempotency-Key must be visible ASCII", async () => {
  const res = await call("POST", "/items", { ...alice, "Idempotency-Key": "has space" }, createRaw);
  assert.equal(res.status, 400);
  assert.equal(await jobCount(), 0);
});
