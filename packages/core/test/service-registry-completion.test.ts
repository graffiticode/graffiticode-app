// Service registry availability and completion validators.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCompletion, type CompletionEvidence } from "../src/service-completion.js";

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
