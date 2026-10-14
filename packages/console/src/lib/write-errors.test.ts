// node:test via tsx: `npm test`.
import test from "node:test";
import assert from "node:assert/strict";
import { describeWriteProblem, canRetryWrite, isCheckableWrite, reconcileTarget, describeReconcile } from "./write-errors";

const failed = (message: string) => describeWriteProblem({ status: "failed", message });

// The api's W4 refusal messages, as the console records them (message, then
// the reason code when the message doesn't already name it).
const W4 = {
  "invocation-incompatible": "Error: this run started under an earlier permission contract and can't be resumed. Start a new run (a new idempotency key); it may repeat writes this run already made (invocation-incompatible)",
  "pinned-revision-unavailable": "Error: the compiler revision this run was admitted on is no longer available (s0); start a new run, which may repeat its writes (pinned-revision-unavailable)",
  "plan-mismatch": "Error: permission denied (plan-mismatch)",
  "stage-not-pinnable": "Error: permission denied (stage-not-pinnable)",
  "language-override-refused": "Error: a language override (L0176) can't run through a connection; remove it to run this (language-override-refused)",
  "revision-not-approved": "Error: permission denied (revision-not-approved)",
  "preflight-unavailable": "Error: preflight of s0 failed (503) (preflight-unavailable)",
  "token-expiring": "Error: /v1/execute failed (409) (token-expiring)",
};

test("a pre-cutover run explains itself and points to Recompile, not Retry (it would loop)", () => {
  const p = failed(W4["invocation-incompatible"]);
  assert.equal(p?.retryable, false);
  assert.match(p!.text, /security update/);
  assert.match(p!.text, /Recompile/);
  // Retry is offered only if the current connection has changed.
  assert.equal(canRetryWrite(p, { connectionId: "c1" }, "c1"), false);
  assert.equal(canRetryWrite(p, { connectionId: "c1" }, "c2"), true);
});

test("every W4 refusal gets a plain explanation and the right retry decision", () => {
  const retryable: Record<string, boolean> = {
    "invocation-incompatible": false, "pinned-revision-unavailable": false, "plan-mismatch": false,
    "stage-not-pinnable": false, "language-override-refused": true,
    "revision-not-approved": true, "preflight-unavailable": true, "token-expiring": true,
  };
  for (const [code, message] of Object.entries(W4)) {
    const p = failed(message);
    assert.ok(p, code);
    assert.equal(p!.retryable, retryable[code], code);
    assert.doesNotMatch(p!.text, /idempotency key|Error:/, `${code}: shows the raw message`);
  }
});

test("an uncertain outcome still says so, and earlier mappings are unchanged", () => {
  const lost = failed("Error: stage s0's compiler didn't answer, so what it did through the connection is uncertain. Check before running it again: a retry with the same key replays only what was recorded (compile-response-lost)");
  assert.equal(lost?.retryable, false);
  assert.match(lost!.text, /uncertain/);
  assert.equal(failed("Error: permission denied (not-granted)")?.retryable, false);
  assert.equal(failed("something unexpected")?.retryable, true);
  assert.equal(describeWriteProblem({ status: "ok", message: null }), null);
});

// Reconciliation (capability W5, WRITE-02).
test("a partial save is explained, and Retry isn't offered: it would only replay the partial outcome", () => {
  const p = failed("Error: Item bank save partial: items write failed (authorization-denied:not-granted)");
  assert.equal(p?.retryable, false);
  assert.match(p!.text, /Only part of this save/);
});

test("only an uncertain or partial save can be checked", () => {
  assert.equal(isCheckableWrite({ status: "failed", message: "Error: Item bank save uncertain: socket hang up" }), true);
  assert.equal(isCheckableWrite({ status: "failed", message: "Error: Item bank save partial: items" }), true);
  assert.equal(isCheckableWrite({ status: "failed", message: "Error: permission denied (not-granted)" }), false);
  assert.equal(isCheckableWrite({ status: "ok" }), false);
  assert.equal(isCheckableWrite(null), false);
});

test("a check targets the exact attempt: after a fresh rerun, reloaded, it's the rerun's key, never a derived one", () => {
  const uncertain = "Error: Item bank save uncertain: socket hang up";
  // The first save, then a deliberate rerun with a fresh key; each replaces lastWrite.
  const first = { taskId: "t1", connectionId: "conn-1", status: "failed", message: uncertain, idempotencyKey: "save:item-1:t1:conn-1" };
  const rerun = { ...first, idempotencyKey: "recompile:3f2a…", at: 2 };
  // As stored and read back after a reload.
  const reloaded = JSON.parse(JSON.stringify(rerun));
  assert.deepEqual(reconcileTarget(reloaded), { connectionId: "conn-1", idempotencyKey: "recompile:3f2a…" });
  assert.notDeepEqual(reconcileTarget(reloaded), reconcileTarget(first));
  // A save from before keys were stored can't be checked.
  const { idempotencyKey: _k, ...legacy } = first;
  assert.equal(reconcileTarget(legacy), null);
  assert.equal(reconcileTarget({ ...rerun, connectionId: null }), null);
});

test("a check's verdict reads plainly: confirmed only when every record carries the save's mark", () => {
  const applied = describeReconcile({ operations: [{ verdict: "applied", final: true, records: [{ landed: true }, { landed: true }] }] });
  assert.equal(applied.verdict, "applied");
  assert.match(applied.text, /^Confirmed/);

  const unresolved = describeReconcile({ operations: [{ verdict: "unresolved", final: false, records: [{ landed: true, found: true, matches: true }, { landed: false, found: true, matches: false }] }] });
  assert.equal(unresolved.verdict, "unresolved");
  assert.match(unresolved.text, /1 of 2 records .* carry its mark, and the item bank now holds different content/);
  assert.match(unresolved.text, /may repeat/);

  const early = describeReconcile({ operations: [{ verdict: "too-early", retryAfter: "2026-10-14T18:00:00.000Z" }] });
  assert.deepEqual([early.verdict, early.retryAfter], ["too-early", "2026-10-14T18:00:00.000Z"]);

  assert.match(describeReconcile({ operations: [{ verdict: "unresolved", reason: "no-evidence" }] }).text, /before saves could be checked/);
  assert.match(describeReconcile({ operations: [{ verdict: "unresolved", reason: "read-failed" }] }).text, /couldn't be read/);
  // An applied verdict that isn't final, or none at all, never confirms.
  assert.equal(describeReconcile({ operations: [{ verdict: "applied", final: false }] }).verdict, "unresolved");
  assert.equal(describeReconcile({ operations: [] }).verdict, "unresolved");
});
