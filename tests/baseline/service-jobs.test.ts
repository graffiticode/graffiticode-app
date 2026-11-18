// Service jobs (execution observation plan, W6 and D-1): the store, its
// idempotency bindings, event sequence and persisted step keys. New in M1a;
// no provider writes are involved.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, PROJECT, type Harness } from "./harness";

let h: Harness;
let jobs: typeof import("@graffiticode-app/core/service-jobs");
let runtime: typeof import("@graffiticode-app/core/profile/runtime");
before(async () => {
  h = await start();
  jobs = await import("@graffiticode-app/core/service-jobs");
  runtime = await import("@graffiticode-app/core/profile/runtime");
  // Services come from the installation's profile (plan P4): the services
  // fixture, at the harness's project and mock hosts.
  const dir = mkdtempSync(join(tmpdir(), "profile-services-"));
  cpSync(new URL("../../packages/core/test/fixtures/installation-services", import.meta.url).pathname, dir, { recursive: true });
  const p = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8"));
  p.installation.project = PROJECT;
  Object.assign(p.hosts, { api: process.env.NEXT_PUBLIC_GC_API_URL, auth: process.env.NEXT_PUBLIC_GC_AUTH_URL, console: process.env.CONSOLE_URL });
  writeFileSync(join(dir, "profile.json"), JSON.stringify(p));
  runtime.loadInstallation({ ...process.env, PROFILE_DIR: dir });
});
after(async () => { runtime?.resetInstallation(); await h?.stop(); });
beforeEach(async () => { await h.resetFirestore(); });

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const alice = { kind: "user" as const, uid: "alice" };
const bob = { kind: "user" as const, uid: "bob" };
const T0 = Date.UTC(2026, 10, 16);

const request = (over: Record<string, unknown> = {}) => ({
  serviceId: "learnosity-assessment-authoring",
  skillId: "author_content",
  principal: alice,
  scope: "uid:alice",
  intent: "Five questions on photosynthesis.",
  deliverable: { kind: "content" as const, requestedState: "prepared" as const },
  inputDigest: "digest-1",
  idempotencyKey: "key-1",
  now: T0,
  ...over,
});

const keyDoc = async (scope: string, key: string) =>
  (await h.db.doc(`service-job-keys/${jobs.serviceJobKeyId(scope, key)}`).get()).data();

const finish = (jobId: string, now: number) => jobs.transitionServiceJob(jobId, () => ({
  status: { state: "completed", externalOutcome: "not_requested", verdict: { met: true, findings: [] } },
}), { now });

test("the same key and input returns the same job; a different input is a conflict", async () => {
  const first = await jobs.createServiceJob(request());
  assert.equal(first.kind, "created");
  const again = await jobs.createServiceJob(request({ now: T0 + 1000 }));
  assert.equal(again.kind, "existing");
  assert.equal(again.job.jobId, first.job.jobId);
  await assert.rejects(jobs.createServiceJob(request({ inputDigest: "digest-2" })), (e: any) => e.reason === "idempotency_key_mismatch");
});

test("a live job's binding outlives generation's 24-hour claims (D-1)", async () => {
  const first = await jobs.createServiceJob(request());
  assert.equal((await keyDoc("uid:alice", "key-1")).expiresAt, null);
  const dayTwo = await jobs.createServiceJob(request({ now: T0 + 3 * DAY }));
  assert.equal(dayTwo.kind, "existing");
  assert.equal(dayTwo.job.jobId, first.job.jobId);
});

test("a terminal job's binding lasts its retry window, then the key starts a new job", async () => {
  const first = await jobs.createServiceJob(request());
  await finish(first.job.jobId, T0 + HOUR);
  const k = await keyDoc("uid:alice", "key-1");
  const window = first.job.envelope.retryWindowMs;
  assert.equal(k.expiresAt.toMillis(), T0 + HOUR + window);

  const within = await jobs.createServiceJob(request({ now: T0 + HOUR + window - 1 }));
  assert.equal(within.job.jobId, first.job.jobId);
  const later = await jobs.createServiceJob(request({ now: T0 + HOUR + window + 1 }));
  assert.equal(later.kind, "created");
  assert.notEqual(later.job.jobId, first.job.jobId);
});

test("keys are scoped to the account boundary", async () => {
  const a = await jobs.createServiceJob(request());
  const b = await jobs.createServiceJob(request({ principal: bob, scope: "uid:bob" }));
  assert.notEqual(a.job.jobId, b.job.jobId);
});

test("transitions advance the revision and commit a monotonic event sequence", async () => {
  const { job } = await jobs.createServiceJob(request());
  await jobs.transitionServiceJob(job.jobId, () => ({ status: { state: "working" }, events: [{ type: "generation_started" }] }), { now: T0 + 1 });
  await finish(job.jobId, T0 + 2);
  const events = await jobs.readServiceJobEvents(job.jobId);
  assert.deepEqual(events.map(e => e.seq), [1, 2, 3, 4]);
  assert.deepEqual(events.map(e => e.type), ["created", "generation_started", "state_changed", "state_changed"]);
  assert.deepEqual((await jobs.readServiceJobEvents(job.jobId, { after: 2 })).map(e => e.seq), [3, 4]);
  const read = await jobs.readServiceJob(job.jobId);
  assert.equal(read!.status.seq, 4);
  assert.equal(read!.status.state, "completed");
  assert.equal(read!.status.terminalAt, T0 + 2);
});

test("a terminal job never changes; a stale revision is refused", async () => {
  const { job } = await jobs.createServiceJob(request());
  await assert.rejects(jobs.transitionServiceJob(job.jobId, () => ({ status: { state: "working" } }), { expectedRevision: 99 }), (e: any) => e.reason === "job_revision_stale");
  await finish(job.jobId, T0 + 1);
  await assert.rejects(jobs.transitionServiceJob(job.jobId, () => ({ status: { state: "working" } })), (e: any) => e.reason === "job_terminal");
  await assert.rejects(jobs.recordStep(job.jobId, { stepId: "late", kind: "command", owned: true }), (e: any) => e.reason === "job_terminal");
});

test("a step's backend key is derived once and read back on every retry", async () => {
  const { job } = await jobs.createServiceJob(request());
  const first = await jobs.recordStep(job.jobId, { stepId: "generate-1", kind: "generation", owned: true }, { now: T0 + 1 });
  const retry = await jobs.recordStep(job.jobId, { stepId: "generate-1", kind: "generation", owned: true, backendKey: "something-else" }, { now: T0 + 2 });
  assert.equal(retry.backendKey, first.backendKey);
  assert.equal(retry.createdAt, T0 + 1);
  assert.equal(first.backendKey, jobs.stepBackendKey(job.jobId, "generate-1"));
});

test("steps carry protocol-aware execution references, set once", async () => {
  const { job } = await jobs.createServiceJob(request());
  await jobs.recordStep(job.jobId, { stepId: "save", kind: "adopted", owned: false });
  const legacy = { protocol: "legacy" as const, invocationId: "inv-1" };
  const bound = await jobs.bindStepExecution(job.jobId, "save", legacy);
  assert.deepEqual(bound.ref, legacy);
  // Binding the same reference again is a no-op; a different one is refused.
  assert.deepEqual((await jobs.bindStepExecution(job.jobId, "save", legacy)).ref, legacy);
  await assert.rejects(jobs.bindStepExecution(job.jobId, "save", { protocol: "command", commandId: "c9" }), (e: any) => e.reason === "step_execution_bound");
  const read = await jobs.readServiceJob(job.jobId);
  assert.deepEqual(read!.steps.save.ref, legacy);
  assert.equal(read!.steps.save.owned, false);
});

test("a job id is not a grant: another principal's job reads as not found", async () => {
  const { job } = await jobs.createServiceJob(request());
  assert.equal((await jobs.serviceJobFor(job.jobId, alice)).jobId, job.jobId);
  await assert.rejects(jobs.serviceJobFor(job.jobId, bob), (e: any) => e.code === "not_found");
});

test("unavailable skills and unsupported deliverables are refused before a job exists", async () => {
  await assert.rejects(jobs.createServiceJob(request({ skillId: "save_revision", deliverable: { kind: "content", requestedState: "saved" } })), (e: any) => e.reason === "skill_unavailable");
  await assert.rejects(jobs.createServiceJob(request({ deliverable: { kind: "content", requestedState: "saved" } })), (e: any) => e.reason === "deliverable_unsupported");
  assert.equal((await h.db.collection("service-jobs").get()).size, 0);
});

test("a cancel request is recorded once, as an event", async () => {
  const { job } = await jobs.createServiceJob(request());
  await jobs.requestServiceJobCancel(job.jobId, { now: T0 + 1 });
  await jobs.requestServiceJobCancel(job.jobId, { now: T0 + 2 });
  const read = await jobs.readServiceJob(job.jobId);
  assert.equal(read!.status.cancelRequested, true);
  assert.deepEqual((await jobs.readServiceJobEvents(job.jobId)).filter(e => e.type === "cancel_requested").length, 1);
});
