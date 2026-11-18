// The service-tool family (installations plan, P4; execution observation
// plan W6/W7): tools generated from the installation's service definitions,
// each a service job running one write-free generation under its pinned
// definition. Ports the parked Learnosity endpoint's tests to the generic
// family, and adds what P4 changes: selection, pinning and withdrawal.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, userToken, PROJECT, type Harness } from "./harness";

const SERVICES = new URL("../../packages/core/test/fixtures/installation-services", import.meta.url).pathname;

let h: Harness;
let tools: typeof import("../../packages/mcp-server/src/service-tools");
let runtime: typeof import("@graffiticode-app/core/profile/runtime");
let jobs: typeof import("@graffiticode-app/core/service-jobs");
let runner: typeof import("@graffiticode-app/core/service-runner");
let protocol: any;

// The services fixture, at the harness's project and mock hosts.
function profileDir(edit: (p: any) => void = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "profile-services-"));
  cpSync(SERVICES, dir, { recursive: true });
  const p = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8"));
  p.installation.project = PROJECT;
  Object.assign(p.hosts, { api: process.env.NEXT_PUBLIC_GC_API_URL, auth: process.env.NEXT_PUBLIC_GC_AUTH_URL, console: process.env.CONSOLE_URL });
  edit(p);
  writeFileSync(join(dir, "profile.json"), JSON.stringify(p));
  return dir;
}
const install = (dir: string) => {
  runtime.resetInstallation();
  runtime.loadInstallation({ ...process.env, PROFILE_DIR: dir });
};
const withoutAuthoring = (p: any) => { p.services[0].skills = p.services[0].skills.filter((k: any) => k.skillId !== "author_content"); };

let BASE: string;
before(async () => {
  h = await start();
  runtime = await import("@graffiticode-app/core/profile/runtime");
  tools = await import("../../packages/mcp-server/src/service-tools");
  jobs = await import("@graffiticode-app/core/service-jobs");
  runner = await import("@graffiticode-app/core/service-runner");
  protocol = await import("@graffiticode-app/core/generation-protocol");
  BASE = profileDir();
});
after(async () => {
  runtime?.resetInstallation();
  await h?.stop();
});
beforeEach(async () => {
  delete process.env.CAPABILITIES_WITHDRAWN;
  install(BASE);
  await h.resetFirestore();
  await h.db.doc("system/generation-protocol").set({ minProtocol: 2, activatedAt: Date.now(), activatedBy: "baseline" });
  protocol.resetProtocolFloorCache();
});

const alice = { token: userToken("alice") };
const bob = { token: userToken("bob") };
const surface = () => tools.serviceSurfaces()[0];
const call = (name: string, args: Record<string, unknown>, creds = alice) => tools.callServiceTool(surface(), name, args, creds, { clientKind: "baseline" });
const connectionWrites = () => h.calls.filter(c => (c.path === "/compile" || c.path === "/command") && c.body?.connectionId);

test("the catalog is generated from the profile, and nothing in it can write", () => {
  assert.deepEqual(tools.serviceSurfaces(), [{ path: "/learnosity/mcp", serviceIds: null }]);
  assert.deepEqual(tools.surfaceTools(surface()).map(t => t.name),
    ["assessment_create_item", "assessment_update_item", "authoring_integration_plan", "data_plan", "job_get", "job_cancel"]);
  tools.assertServiceCatalogsWriteFree();
  for (const t of tools.surfaceTools(surface())) assert.equal(t.annotations.destructiveHint, false, t.name);
});

test("create starts a write-free job under its pinned definition; job_get reports it completed with a link", async () => {
  h.enablePolicy();
  h.setConnections([{ connectionId: "conn-1", backend: "learnosity", status: "active", label: "Item bank", ownerPermissions: null }]);
  const started = await call("assessment_create_item", { description: "A multiple choice question about photosynthesis. Save it to my item bank." });
  assert.equal(started.state, "working");
  assert.equal(started.service_id, "learnosity-assessment-authoring");

  const job = (await jobs.readServiceJob(String(started.job_id)))!;
  assert.equal(job.envelope.envelopeVersion, 2);
  assert.equal(job.envelope.definition.skill.skillId, "author_content");
  assert.equal(job.envelope.definition.capability.id, "generate-content");
  assert.match(job.envelope.definitionDigest, /^[0-9a-f]{64}$/);

  await h.drainJobs();
  const done = await call("job_get", { job_id: started.job_id });
  assert.equal(done.state, "completed");
  assert.equal(done.external_outcome, "not_requested");
  assert.ok(done.task_id);
  assert.match(String(done.view_url), new RegExp(`/form/${done.item_id}$`));
  assert.match(String(done.summary), /Nothing was written outside Example/);

  const gens = (await h.db.collection("generation-jobs").get()).docs.map((d: any) => d.data());
  assert.equal(gens.length, 1);
  assert.equal(gens[0].envelope.externalWrites, false);
  assert.equal(String(gens[0].envelope.lang).replace(/^L/i, ""), "0176", "the skill's language, from its pinned definition");
  assert.deepEqual(connectionWrites(), [], "nothing sent through the connection");
});

test("an idempotency key replays the same job; reused with another request it is refused", async () => {
  const a = await call("assessment_create_item", { description: "Q1", idempotency_key: "k-1" });
  const b = await call("assessment_create_item", { description: "Q1", idempotency_key: "k-1" });
  assert.equal(b.job_id, a.job_id);
  assert.equal((await h.db.collection("generation-jobs").get()).size, 1);
  await assert.rejects(call("assessment_create_item", { description: "Q2", idempotency_key: "k-1" }), (e: any) => e.reason === "idempotency_key_mismatch");
});

test("revise is a new job on the same item; a missing item is rejected with its reason", async () => {
  const created = await call("assessment_create_item", { description: "A question about cells." });
  await h.drainJobs();
  const { item_id } = await call("job_get", { job_id: created.job_id });
  const revised = await call("assessment_update_item", { item_id, modification: "Make it harder." });
  assert.notEqual(revised.job_id, created.job_id);
  await h.drainJobs();
  const done = await call("job_get", { job_id: revised.job_id });
  assert.equal(done.state, "completed");
  assert.equal(done.item_id, item_id);

  const missing = await call("assessment_update_item", { item_id: "no-such-item", modification: "x" });
  assert.equal(missing.state, "rejected");
  assert.equal((missing.refusal as any).reason, "not_found");
});

test("data_plan completes as a plan; no live operation", async () => {
  const started = await call("data_plan", { description: "Export all sessions for activity X, all pages, and delete them afterwards." });
  assert.equal(started.service_id, "learnosity-data-operations");
  await h.drainJobs();
  const done = await call("job_get", { job_id: started.job_id });
  assert.equal(done.state, "completed");
  assert.deepEqual(done.deliverable, { kind: "data_plan", requested_state: "planned" });
  assert.deepEqual(connectionWrites(), []);
});

test("a job id is not a grant: another account's job reads as not found", async () => {
  const started = await call("assessment_create_item", { description: "Q" });
  await assert.rejects(call("job_get", { job_id: started.job_id }, bob), (e: any) => e.reason === "not_found");
  await assert.rejects(call("job_cancel", { job_id: started.job_id }, bob), (e: any) => e.reason === "not_found");
});

test("cancel ends the job canceled, once", async () => {
  const started = await call("assessment_create_item", { description: "Q" });
  assert.equal((await call("job_cancel", { job_id: started.job_id })).state, "canceled");
  await h.drainJobs();
  assert.equal((await call("job_cancel", { job_id: started.job_id })).state, "canceled");
  assert.equal((await call("job_get", { job_id: started.job_id })).state, "canceled");
});

test("invalid arguments and unknown tools are refused before a job exists", async () => {
  await assert.rejects(call("assessment_create_item", {}), (e: any) => e.reason === "invalid_argument");
  await assert.rejects(call("assessment_create_item", { description: "Q", idempotency_key: "has space" }), (e: any) => e.reason === "invalid_argument");
  await assert.rejects(call("no_such_tool", {}), (e: any) => e.reason === "unknown_tool");
  assert.equal((await h.db.collection("service-jobs").get()).size, 0);
});

test("after a skill is deselected: a new job is refused, a same-key retry returns its job, and the job finishes under its pinned definition", async () => {
  const started = await call("assessment_create_item", { description: "Q", idempotency_key: "keep" });
  const pinned = (await jobs.readServiceJob(String(started.job_id)))!.envelope;

  install(profileDir(withoutAuthoring));
  assert.ok(!tools.surfaceTools(surface()).some(t => t.name === "assessment_create_item"), "no longer offered");
  await assert.rejects(call("assessment_create_item", { description: "Q2" }), (e: any) => e.reason === "unknown_tool");
  // Core refuses new work for it too, whatever the caller.
  await assert.rejects(jobs.createServiceJob({
    serviceId: "learnosity-assessment-authoring", skillId: "author_content", principal: { kind: "user", uid: "alice" }, scope: "uid:alice",
    intent: "Q3", deliverable: { kind: "content", requestedState: "prepared" }, inputDigest: "d", idempotencyKey: "other",
  } as any), (e: any) => e.reason === "skill_unavailable");

  const retried = await call("assessment_create_item", { description: "Q", idempotency_key: "keep" });
  assert.equal(retried.job_id, started.job_id, "the same key gets the recorded job");
  await assert.rejects(call("assessment_create_item", { description: "Other", idempotency_key: "keep" }), (e: any) => e.reason === "idempotency_key_mismatch");

  await h.drainJobs();
  const done = await call("job_get", { job_id: started.job_id });
  assert.equal(done.state, "completed");
  assert.deepEqual((await jobs.readServiceJob(String(started.job_id)))!.envelope.definition, pinned.definition, "judged under its pin");
  assert.equal((await call("job_cancel", { job_id: started.job_id })).state, "completed", "cancel still answers; an ended job stays ended");
});

test("a job keeps its pinned definition after the profile changes", async () => {
  const started = await call("data_plan", { description: "Plan an export." });
  const before = (await jobs.readServiceJob(String(started.job_id)))!.envelope;
  install(profileDir(p => { p.services[1].skills[0].description = "A different description."; p.services[1].version = 2; }));
  await h.drainJobs();
  const done = await call("job_get", { job_id: started.job_id });
  assert.equal(done.state, "completed");
  const after = (await jobs.readServiceJob(String(started.job_id)))!.envelope;
  assert.equal(after.definitionDigest, before.definitionDigest);
  assert.equal(after.serviceVersion, 1);
  // New work starts under the new definition.
  const next = await call("data_plan", { description: "Plan another export." });
  const nextEnv = (await jobs.readServiceJob(String(next.job_id)))!.envelope;
  assert.equal(nextEnv.serviceVersion, 2);
  assert.notEqual(nextEnv.definitionDigest, before.definitionDigest);
});

test("a withdrawn capability starts nothing new: no tools, jobs without a step fail, work in flight still settles", async () => {
  const inFlight = await call("assessment_create_item", { description: "Already started." });
  const unstarted = await jobs.createServiceJob({
    serviceId: "learnosity-assessment-authoring", skillId: "author_content", principal: { kind: "user", uid: "alice" }, scope: "uid:alice",
    intent: "Never started.", deliverable: { kind: "content", requestedState: "prepared" }, inputDigest: "d-unstarted",
  } as any);

  process.env.CAPABILITIES_WITHDRAWN = "generate-content";
  assert.deepEqual(tools.surfaceTools(surface()).map(t => t.name), ["job_get", "job_cancel"]);
  await assert.rejects(call("data_plan", { description: "Plan." }), (e: any) => e.reason === "unknown_tool");

  const failed = await call("job_get", { job_id: unstarted.job.jobId });
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.findings, ["capability-withdrawn: generate-content"]);
  // Starting its step directly is refused the same way.
  const another = await jobs.createServiceJob({
    serviceId: "learnosity-data-operations", skillId: "plan_data_job", principal: { kind: "user", uid: "alice" }, scope: "uid:alice",
    intent: "x", deliverable: { kind: "data_plan", requestedState: "planned" }, inputDigest: "d-2",
    skillContext: { withdrawn: new Set() },
  } as any);
  await assert.rejects(runner.startGenerationStep(another.job.jobId, "generate", async () => {}), (e: any) => e.reason === "capability_withdrawn");
  assert.equal((await jobs.readServiceJob(another.job.jobId))!.status.state, "failed");

  await h.drainJobs();
  const settled = await call("job_get", { job_id: inFlight.job_id });
  assert.equal(settled.state, "completed", "a step already reserved settles");
  assert.equal((await call("job_cancel", { job_id: unstarted.job.jobId })).state, "failed", "cancel still answers");
});

// --- review fixes ---------------------------------------------------------------

const authoringJob = (over: Record<string, unknown> = {}) => jobs.createServiceJob({
  serviceId: "learnosity-assessment-authoring", skillId: "author_content", principal: { kind: "user", uid: "alice" }, scope: "uid:alice",
  intent: "Q", deliverable: { kind: "content", requestedState: "prepared" }, inputDigest: "d-recover",
  request: { surface: "/learnosity/mcp", tool: "assessment_create_item", operation: "create", input: { description: "A question about plants." } },
  ...over,
} as any);

test("a start that fails after its generation was reserved keeps the generation: the job completes", async () => {
  const handlers = await import("@graffiticode-app/core/capability-handlers");
  const { job } = await authoringJob();
  const gen = await runner.startGenerationStep(job.jobId, "generate", async claim => {
    await handlers.startOperation(job, { token: alice.token }, claim);
    throw new Error("injected after the reservation");
  });
  assert.ok(gen.generationId, "recovered, not reported as a failure");
  assert.equal((await jobs.readServiceJob(job.jobId))!.status.state, "working");
  await h.drainJobs();
  assert.equal((await call("job_get", { job_id: job.jobId })).state, "completed");
  assert.equal((await h.db.collection("generation-jobs").get()).size, 1, "nothing reserved twice");
});

test("a reservation whose step reference never landed is recovered, not failed, even when withdrawn", async () => {
  const started = await call("assessment_create_item", { description: "Q" });
  // As if the request died after reserving and before recording the step's reference.
  await h.db.doc(`service-jobs/${started.job_id}`).update({ "steps.generate.generation": null });
  process.env.CAPABILITIES_WITHDRAWN = "generate-content";
  const seen = await call("job_get", { job_id: started.job_id });
  assert.notEqual(seen.state, "failed", "a reserved generation is in flight");
  await h.drainJobs();
  assert.equal((await call("job_get", { job_id: started.job_id })).state, "completed");
});

test("a key's request identity includes its endpoint: two endpoints' same-named tools never share a job", async () => {
  install(profileDir(p => {
    p.services[0].skills[1].tools = [{ operation: "create", name: "plan" }];
    p.services[1].skills[0].tools = [{ operation: "create", name: "plan" }];
    p.surfaces.mcp = [{ path: "/mcp", families: ["items"] },
      { path: "/authoring/mcp", families: ["services"], services: [p.services[0].serviceId] },
      { path: "/data/mcp", families: ["services"], services: [p.services[1].serviceId] }];
  }));
  const [a, d] = tools.serviceSurfaces();
  const args = { description: "Plan it.", idempotency_key: "same" };
  const first = await tools.callServiceTool(a, "plan", args, alice);
  assert.equal(first.service_id, "learnosity-assessment-authoring");
  await assert.rejects(tools.callServiceTool(d, "plan", args, alice), (e: any) => e.reason === "idempotency_key_mismatch",
    "the same key on another endpoint is another request");
});

test("a same-key retry resumes its recorded request, whatever the tool means now", async () => {
  const first = await call("assessment_create_item", { description: "Q", idempotency_key: "k-op" });
  // The tool's name now means revise, which needs other input.
  install(profileDir(p => { p.services[0].skills[0].tools = [{ operation: "revise", name: "assessment_create_item" }]; }));
  const again = await call("assessment_create_item", { description: "Q", idempotency_key: "k-op" });
  assert.equal(again.job_id, first.job_id);
  assert.notEqual(again.state, "rejected");
});

test("after deselection, a job whose first request died before its step starts under its pin", async () => {
  const args = { description: "Q", idempotency_key: "k-died" };
  const { job } = await authoringJob({
    idempotencyKey: "k-died",
    inputDigest: runner.digestInput({ surface: "/learnosity/mcp", tool: "assessment_create_item", arguments: { description: "Q" } }),
    request: { surface: "/learnosity/mcp", tool: "assessment_create_item", operation: "create", input: { description: "Q" } },
  });
  assert.equal(job.status.state, "accepted");
  install(profileDir(withoutAuthoring));
  const resumed = await call("assessment_create_item", args);
  assert.equal(resumed.job_id, job.jobId);
  assert.equal(resumed.state, "working", "its step started, under its pin");
  await h.drainJobs();
  assert.equal((await call("job_get", { job_id: job.jobId })).state, "completed");
});

test("revise keeps its item's language, and refuses an item outside the skill's languages", async () => {
  const plan = await call("data_plan", { description: "Plan an export." });
  await h.drainJobs();
  const { item_id } = await call("job_get", { job_id: plan.job_id });
  const refused = await call("assessment_update_item", { item_id, modification: "Make it a question instead." });
  assert.equal(refused.state, "rejected");
  assert.equal((refused.refusal as any).reason, "item_language_mismatch");
  assert.equal((await h.db.collection("generation-jobs").get()).size, 1, "nothing generated for it");
});

// --- second review ----------------------------------------------------------------

test("when recovery can't be established, the job stays open; it is never rejected over a reservation", async () => {
  const handlers = await import("@graffiticode-app/core/capability-handlers");
  const { job } = await authoringJob();
  // Reserve, then fail; and recovery itself fails (as when its writes keep failing).
  await assert.rejects(runner.startGenerationStep(job.jobId, "generate", async claim => {
    await handlers.startOperation(job, { token: alice.token }, claim);
    throw new Error("injected after the reservation");
  }, {
    // The check before reserving works; the recovery after the failure doesn't.
    recover: (() => { let calls = 0; return async (...args: Parameters<typeof runner.recoverStepGeneration>) => {
      if (calls++ === 0) return runner.recoverStepGeneration(...args);
      throw new Error("storage unavailable");
    }; })(),
  }), (e: any) => e.reason === "recovery_unavailable");
  assert.notEqual((await jobs.readServiceJob(job.jobId))!.status.state, "rejected", "still open");
  // A rejection checks the step's claim in its own transaction: the reservation is attached instead.
  const r = await runner.rejectServiceJob(job.jobId, { reason: "x", message: "x" });
  assert.equal(r.kind, "reserved");
  await h.drainJobs();
  assert.equal((await call("job_get", { job_id: job.jobId })).state, "completed");
  assert.equal((await h.db.collection("generation-jobs").get()).size, 1);
});

test("withdrawal never races a request holding a claim: in progress while fresh, revoked once abandoned", async () => {
  const handlers = await import("@graffiticode-app/core/capability-handlers");
  // A request that has its claim and pauses before reserving.
  const pause = (job: any) => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const run = runner.startGenerationStep(job.jobId, "generate", async claim => { await gate; return handlers.startOperation(job, { token: alice.token }, claim); });
    return { release, run };
  };
  const claimOf = async (jobId: string) => {
    const j = (await jobs.readServiceJob(jobId))!;
    const { idempotencyRef } = await import("@graffiticode-app/core/idempotency");
    return (await idempotencyRef("service-job-step", j.steps.generate.backendKey).get()).data()!;
  };
  const waitForClaim = async (jobId: string) => {
    for (let i = 0; i < 50; i++) {
      const j = await jobs.readServiceJob(jobId);
      if (j?.steps?.generate) {
        const { idempotencyRef } = await import("@graffiticode-app/core/idempotency");
        if ((await idempotencyRef("service-job-step", j.steps.generate.backendKey).get()).exists) return;
      }
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error("the paused request never claimed");
  };

  // Fresh claim: the job isn't ended under it, and the request completes.
  const a = (await authoringJob({ inputDigest: "d-a" })).job;
  const pa = pause(a);
  await waitForClaim(a.jobId);
  process.env.CAPABILITIES_WITHDRAWN = "generate-content";
  assert.notEqual((await call("job_get", { job_id: a.jobId })).state, "failed", "a request is still reserving");
  pa.release();
  await pa.run;
  delete process.env.CAPABILITIES_WITHDRAWN;
  await h.drainJobs();
  assert.equal((await call("job_get", { job_id: a.jobId })).state, "completed");

  // Abandoned claim: the job ends and the claim is revoked in the same commit,
  // so the paused request can't reserve when it resumes.
  const b = (await authoringJob({ inputDigest: "d-b" })).job;
  const pb = pause(b);
  await waitForClaim(b.jobId);
  const claimedAt = Number((await claimOf(b.jobId)).claimedAt);
  const ended = await runner.observeServiceJob(b.jobId, { now: claimedAt + 31_000, withdrawn: new Set(["generate-content"]) });
  assert.equal(ended!.job.status.state, "failed");
  assert.equal((await claimOf(b.jobId)).state, "revoked");
  const before = (await h.db.collection("generation-jobs").get()).size;
  pb.release();
  await assert.rejects(pb.run);
  assert.equal((await h.db.collection("generation-jobs").get()).size, before, "nothing reserved after the job ended");
});

test("a step's claim, its reservation's recovery record, lasts as long as the job can", async () => {
  const started = await call("assessment_create_item", { description: "Q" });
  const job = (await jobs.readServiceJob(String(started.job_id)))!;
  const { idempotencyRef } = await import("@graffiticode-app/core/idempotency");
  const claim = (await idempotencyRef("service-job-step", job.steps.generate.backendKey).get()).data()!;
  const expires = claim.expiresAt.toMillis();
  assert.ok(expires >= job.envelope.deadlineAt + job.envelope.retryWindowMs - 1000, "not generation's 24 hours");
});

test("arguments can't stand in for the surface or tool, and undeclared arguments are refused", async () => {
  install(profileDir(p => {
    p.services[0].skills[1].tools = [{ operation: "create", name: "plan" }];
    p.services[1].skills[0].tools = [{ operation: "create", name: "plan" }];
    p.surfaces.mcp = [{ path: "/mcp", families: ["items"] },
      { path: "/authoring/mcp", families: ["services"], services: [p.services[0].serviceId] },
      { path: "/data/mcp", families: ["services"], services: [p.services[1].serviceId] }];
  }));
  const [a, d] = tools.serviceSurfaces();
  const first = await tools.callServiceTool(a, "plan", { description: "Plan it.", idempotency_key: "nest" }, alice);
  // On the other endpoint, an argument claiming the first one's surface.
  await assert.rejects(tools.callServiceTool(d, "plan", { description: "Plan it.", surface: "/authoring/mcp", idempotency_key: "nest" }, alice),
    (e: any) => ["idempotency_key_mismatch", "invalid_argument"].includes(e.reason));
  await assert.rejects(tools.callServiceTool(d, "plan", { description: "Plan it.", surface: "/authoring/mcp" }, alice), (e: any) => e.reason === "invalid_argument");
  assert.equal((await jobs.readServiceJob(String(first.job_id)))!.envelope.serviceId, "learnosity-assessment-authoring");
  assert.equal((await h.db.collection("service-jobs").get()).size, 1, "no other job");
});

// --- third review: every terminal path goes through the fence -----------------------

// A request that has taken its step's claim and pauses before reserving.
async function pausedRequest() {
  const handlers = await import("@graffiticode-app/core/capability-handlers");
  const { idempotencyRef } = await import("@graffiticode-app/core/idempotency");
  const { job } = await authoringJob({ inputDigest: `d-${Math.random()}` });
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const run = runner.startGenerationStep(job.jobId, "generate", async claim => { await gate; return handlers.startOperation(job, { token: alice.token }, claim); });
  run.catch(() => {}); // asserted by each test
  const claim = async () => {
    const j = (await jobs.readServiceJob(job.jobId))!;
    return j.steps?.generate ? (await idempotencyRef("service-job-step", j.steps.generate.backendKey).get()).data() : undefined;
  };
  for (let i = 0; i < 50 && !(await claim()); i++) await new Promise(r => setTimeout(r, 50));
  const c = await claim();
  assert.equal(c?.state, "claimed", "the request holds its claim");
  return { job, release, run, claim, claimedAt: Number(c!.claimedAt) };
}
const generations = async () => (await h.db.collection("generation-jobs").get()).size;

test("cancel never ends a job under a fresh claim; once the request settles, the job ends canceled", async () => {
  const p = await pausedRequest();
  await jobs.requestServiceJobCancel(p.job.jobId);
  assert.notEqual((await runner.observeServiceJob(p.job.jobId))!.job.status.state, "canceled", "a request is still reserving");
  p.release();
  await p.run;
  assert.equal((await runner.observeServiceJob(p.job.jobId))!.job.status.state, "canceled");
});

test("cancel past an abandoned claim ends the job and revokes the claim together: the request reserves nothing", async () => {
  const p = await pausedRequest();
  await jobs.requestServiceJobCancel(p.job.jobId);
  const before = await generations();
  const ended = await runner.observeServiceJob(p.job.jobId, { now: p.claimedAt + 31_000 });
  assert.equal(ended!.job.status.state, "canceled");
  assert.equal((await p.claim())!.state, "revoked");
  p.release();
  await assert.rejects(p.run);
  assert.equal(await generations(), before, "nothing reserved after the job ended");
});

test("deadline expiry ends the job and revokes the claim together: the request reserves nothing", async () => {
  const p = await pausedRequest();
  const before = await generations();
  const ended = await runner.observeServiceJob(p.job.jobId, { now: p.job.envelope.deadlineAt + 1 });
  assert.equal(ended!.job.status.state, "failed");
  assert.equal((await p.claim())!.state, "revoked");
  p.release();
  await assert.rejects(p.run);
  assert.equal(await generations(), before, "nothing reserved after the job ended");
});

test("no terminal transition bypasses the fence", async () => {
  const p = await pausedRequest();
  await assert.rejects(jobs.transitionServiceJob(p.job.jobId, () => ({ status: { state: "failed" } })), (e: any) => e.reason === "terminal_unfenced");
  p.release();
  await p.run;
});
