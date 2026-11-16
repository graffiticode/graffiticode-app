// Service-job state mapping: A2A design §6.3.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveJobState, type ExecutionView, type JobStateInput } from "../src/service-job-state.js";
import type { EffectEvidence } from "../src/service-outcomes.js";

const c1 = { protocol: "command", commandId: "c1" } as const;
const legacy = { protocol: "legacy", invocationId: "inv-1" } as const;
const effect = (recorded: EffectEvidence["recorded"], execution: EffectEvidence["execution"] = c1): EffectEvidence =>
  ({ execution, stage: "s0", occurrence: "o1", recorded });

const base = (over: Partial<JobStateInput>): JobStateInput =>
  ({ phase: "executing", executions: [], effects: [], effectsRequested: true, ...over });
const owned = (over: Partial<ExecutionView> = {}): ExecutionView => ({ ref: c1, owned: true, lifecycle: "terminal", ...over });

test("an uncertain command whose run awaits reconciliation is interrupted, not failed", () => {
  const r = deriveJobState(base({
    executions: [owned({ lifecycle: "interrupted", interrupt: { interruptId: "i1", revision: 1, kind: "reconciliation", resolver: "user" } })],
    effects: [effect("uncertain")],
  }));
  assert.equal(r.state, "input_required");
  assert.equal(r.externalOutcome, "unknown");
  assert.equal(r.awaiting?.interrupt.interruptId, "i1");
});

test("a caller-resolvable authorization interrupt is auth_required", () => {
  const r = deriveJobState(base({
    executions: [owned({ lifecycle: "interrupted", interrupt: { interruptId: "i1", revision: 2, kind: "authorization", resolver: "user" } })],
    effects: [effect("pending")],
  }));
  assert.equal(r.state, "auth_required");
});

test("an interrupt the caller can't resolve keeps the job working and names the blocker", () => {
  for (const interrupt of [
    { interruptId: "d", revision: 1, kind: "dependency" as const, resolver: "operator" as const },
    { interruptId: "a", revision: 1, kind: "authorization" as const, resolver: "administrator" as const },
  ]) {
    const r = deriveJobState(base({ executions: [owned({ lifecycle: "interrupted", interrupt })], effects: [effect("pending")] }));
    assert.equal(r.state, "working");
    assert.equal(r.blocker?.interrupt.resolver, interrupt.resolver);
  }
});

test("an owned execution still running keeps the job working, even past its deadline", () => {
  const r = deriveJobState(base({ executions: [owned({ lifecycle: "active" })], effects: [effect("pending")], deadlinePassed: true, verdict: { met: false, findings: [] } }));
  assert.equal(r.state, "working");
  assert.equal(r.detached, undefined);
});

test("a settled job's success comes from the validators, its outcome from the evidence", () => {
  const met = deriveJobState(base({ executions: [owned()], effects: [effect("completed")], verdict: { met: true, findings: [] } }));
  assert.deepEqual([met.state, met.externalOutcome], ["completed", "applied"]);
  // Validation failure keeps the record of what was written.
  const unmet = deriveJobState(base({ executions: [owned()], effects: [effect("completed")], verdict: { met: false, findings: ["no references"] } }));
  assert.deepEqual([unmet.state, unmet.externalOutcome], ["failed", "applied"]);
});

test("a settled command whose evidence is still pending doesn't end the job", () => {
  const r = deriveJobState(base({ executions: [owned()], effects: [effect("pending")], verdict: { met: true, findings: [] } }));
  assert.equal(r.state, "working");
});

test("an adopter past its deadline detaches; the shared execution is left running", () => {
  const adopted: ExecutionView = { ref: legacy, owned: false, lifecycle: "active" };
  const running = deriveJobState(base({ executions: [adopted], effects: [effect("pending", legacy)] }));
  assert.equal(running.state, "working");

  const timedOut = deriveJobState(base({ executions: [adopted], effects: [effect("pending", legacy)], deadlinePassed: true }));
  assert.equal(timedOut.state, "failed");
  assert.equal(timedOut.externalOutcome, "pending");
  assert.deepEqual(timedOut.detached, { refs: [legacy] });

  const canceled = deriveJobState(base({ executions: [adopted], effects: [effect("pending", legacy)], cancelRequested: true }));
  assert.equal(canceled.state, "failed");
  assert.deepEqual(canceled.detached, { refs: [legacy] });
});

test("an adopted execution that settled is judged like any other", () => {
  const r = deriveJobState(base({ executions: [{ ref: legacy, owned: false, lifecycle: "terminal" }], effects: [effect("completed", legacy)], verdict: { met: true, findings: [] } }));
  assert.deepEqual([r.state, r.externalOutcome], ["completed", "applied"]);
});

test("a caller's stop of an owned run ends as canceled", () => {
  const r = deriveJobState(base({ executions: [owned({ stopped: true })], effects: [effect("completed")], cancelRequested: true }));
  assert.deepEqual([r.state, r.externalOutcome], ["canceled", "applied"]);
});

test("preparation: accepted, then working; a question is input_required; cancel is canceled", () => {
  const prep = { executions: [], effects: [], effectsRequested: false };
  assert.equal(deriveJobState({ phase: "accepted", ...prep }).state, "accepted");
  assert.equal(deriveJobState({ phase: "preparing", ...prep }).state, "working");
  assert.equal(deriveJobState({ phase: "preparing", preparationQuestion: true, ...prep }).state, "input_required");
  assert.equal(deriveJobState({ phase: "preparing", cancelRequested: true, ...prep }).state, "canceled");
  const done = deriveJobState({ phase: "preparing", verdict: { met: true, findings: [] }, ...prep });
  assert.deepEqual([done.state, done.externalOutcome], ["completed", "not_requested"]);
});

test("a refusal before allocation is rejected", () => {
  assert.equal(deriveJobState(base({ refused: true })).state, "rejected");
});
