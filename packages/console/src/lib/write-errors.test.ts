// node:test via tsx: `npm test`.
import test from "node:test";
import assert from "node:assert/strict";
import { describeWriteProblem, canRetryWrite } from "./write-errors";

const failed = (message: string) => describeWriteProblem({ status: "failed", message });

// The api's W4 refusal messages, as the console records them (message, then
// the reason code when the message doesn't already name it).
const W4 = {
  "invocation-incompatible": "Error: this run started under an earlier permission contract and can't be resumed. Start a new run (a new idempotency key); it may repeat writes this run already made (invocation-incompatible)",
  "pinned-revision-unavailable": "Error: the compiler revision this run was admitted on is no longer available (s0); start a new run, which may repeat its writes (pinned-revision-unavailable)",
  "plan-mismatch": "Error: permission denied (plan-mismatch)",
  "stage-not-pinnable": "Error: permission denied (stage-not-pinnable)",
  "language-override-refused": "Error: a language override (L0176) can't run through a connection; remove it to run this (language-override-refused)",
  "fn-not-enabled": "Error: permission denied (fn-not-enabled)",
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
    "stage-not-pinnable": false, "language-override-refused": true, "fn-not-enabled": false,
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
