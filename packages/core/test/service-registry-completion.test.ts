// Service registry availability and completion validators.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LEARNOSITY_AUTHORING, LEARNOSITY_DATA, availableSkills, skillAvailable } from "../src/service-registry.js";
import { validateCompletion, type CompletionEvidence } from "../src/service-completion.js";

test("only implemented skills are available; execution skills need execution readiness", () => {
  assert.equal(skillAvailable(LEARNOSITY_AUTHORING, "author_content"), true);
  // Not implemented until M1b, even if execution were ready.
  assert.equal(skillAvailable(LEARNOSITY_AUTHORING, "save_revision", { executionReady: true }), false);
  assert.deepEqual(availableSkills(LEARNOSITY_DATA).map(s => s.skillId), ["plan_data_job"]);
});

test("deployment configuration and caller authorization narrow availability", () => {
  assert.equal(skillAvailable(LEARNOSITY_AUTHORING, "author_content", { enabled: new Set(["plan_authoring_integration"]) }), false);
  assert.equal(skillAvailable(LEARNOSITY_AUTHORING, "author_content", { authorized: false }), false);
  assert.equal(skillAvailable(LEARNOSITY_AUTHORING, "no_such_skill"), false);
});

test("no available skill writes externally in M1a", () => {
  for (const def of [LEARNOSITY_AUTHORING, LEARNOSITY_DATA]) {
    assert.ok(availableSkills(def, { executionReady: true }).every(s => !s.externalWrites));
  }
});

test("public skill ids never encode a language number", () => {
  for (const def of [LEARNOSITY_AUTHORING, LEARNOSITY_DATA]) {
    for (const s of def.skills) assert.doesNotMatch(s.skillId, /\d{4}/);
  }
});

const content = (over: Partial<CompletionEvidence> = {}): CompletionEvidence =>
  ({ deliverableKind: "content", requestedState: "prepared", taskId: "t1", checks: [], externalOutcome: "not_requested", ...over });

test("prepared content needs a revision and passing blocking checks, and no write", () => {
  assert.equal(validateCompletion(content()).met, true);
  assert.equal(validateCompletion(content({ taskId: undefined })).met, false);
  assert.equal(validateCompletion(content({ checks: [{ name: "scoring", passed: false, blocking: true }] })).met, false);
  assert.equal(validateCompletion(content({ checks: [{ name: "style", passed: false, blocking: false }] })).met, true);
  // Preparing content never writes; a write here is a contract failure.
  assert.equal(validateCompletion(content({ externalOutcome: "applied" })).met, false);
});

test("previewed content needs a usable preview", () => {
  assert.equal(validateCompletion(content({ requestedState: "previewed" })).met, false);
  assert.equal(validateCompletion(content({ requestedState: "previewed", previewAvailable: true })).met, true);
});

test("saved content needs settled, applied evidence with provider references", () => {
  const saved = (over: Partial<CompletionEvidence>) => validateCompletion(content({ requestedState: "saved", ...over }));
  assert.equal(saved({ externalOutcome: "applied", providerReferences: ["item-1"] }).met, true);
  assert.equal(saved({ externalOutcome: "applied" }).met, false);
  for (const externalOutcome of ["pending", "unknown", "partially_applied", "not_started"] as const) {
    assert.equal(saved({ externalOutcome }).met, false, externalOutcome);
  }
});

test("a data plan must say no live operation occurred", () => {
  const plan = (over: Partial<CompletionEvidence>) => validateCompletion({ deliverableKind: "data_plan", requestedState: "planned", taskId: "t1", checks: [], externalOutcome: "not_requested", ...over });
  assert.equal(plan({ statesNoLiveOperation: true }).met, true);
  assert.equal(plan({}).met, false);
});

test("an operation result completes with exclusions only when the request permits them", () => {
  const op = (over: Partial<CompletionEvidence>) => validateCompletion({ deliverableKind: "operation_result", requestedState: "applied", checks: [], externalOutcome: "partially_applied", ...over });
  assert.equal(op({}).met, false);
  assert.equal(op({ permitsExclusions: true }).met, true);
  assert.equal(op({ externalOutcome: "applied", providerReferences: ["r"], readBackVerified: false }).met, false);
});
