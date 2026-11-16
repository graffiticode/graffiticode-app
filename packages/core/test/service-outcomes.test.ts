// External outcomes: A2A design §4.3, per-operation evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateExternalOutcome, effectStatus, summarizeEffects, type EffectEvidence } from "../src/service-outcomes.js";

const cmd = { protocol: "command", commandId: "c1" } as const;
const op = (occurrence: string, recorded: EffectEvidence["recorded"], extra: Partial<EffectEvidence> = {}): EffectEvidence =>
  ({ execution: cmd, stage: "s0", occurrence, recorded, ...extra });

test("each operation outcome maps to one effect status", () => {
  assert.equal(effectStatus(op("a", "completed")), "applied");
  assert.equal(effectStatus(op("a", "partial")), "partially_applied");
  assert.equal(effectStatus(op("a", "failed")), "not_applied");
  assert.equal(effectStatus(op("a", "uncertain")), "unresolved");
  assert.equal(effectStatus(op("a", "pending")), "pending");
});

test("reconciliation supersedes an uncertain recorded outcome", () => {
  assert.equal(effectStatus(op("a", "uncertain", { reconciled: "applied" })), "applied");
  assert.equal(effectStatus(op("a", "uncertain", { reconciled: "not_applied" })), "not_applied");
});

test("the repair ledger's current outcome supersedes the original", () => {
  assert.equal(effectStatus(op("a", "failed", { ledger: "completed" })), "applied");
  assert.equal(effectStatus(op("a", "failed", { ledger: "pending" })), "pending");
});

test("an already satisfied target counts as applied, and is reported separately", () => {
  const e = op("a", "completed", { alreadySatisfied: true });
  assert.equal(effectStatus(e), "applied");
  const s = summarizeEffects([e, op("b", "completed")]);
  assert.equal(s.alreadySatisfied.length, 1);
  assert.equal(s.applied.length, 1);
});

test("aggregation follows the §4.3 table, in order", () => {
  assert.equal(aggregateExternalOutcome([], { requested: false }), "not_requested");
  assert.equal(aggregateExternalOutcome([op("a", "completed"), op("b", "pending")]), "pending");
  // Pending is checked before unresolved.
  assert.equal(aggregateExternalOutcome([op("a", "uncertain"), op("b", "pending")]), "pending");
  // Any unresolved effect makes it unknown, even beside applied ones.
  assert.equal(aggregateExternalOutcome([op("a", "completed"), op("b", "uncertain")]), "unknown");
  assert.equal(aggregateExternalOutcome([op("a", "failed"), op("b", "failed")]), "not_started");
  assert.equal(aggregateExternalOutcome([op("a", "completed"), op("b", "completed")]), "applied");
});

test("one completed write and one definite failure in one immediate command is partially applied", () => {
  // The command's aggregate outcome would be `partial`; each effect is classified on its own.
  assert.equal(aggregateExternalOutcome([op("a", "completed"), op("b", "failed")]), "partially_applied");
});

test("a single partial operation is partially applied", () => {
  assert.equal(aggregateExternalOutcome([op("a", "partial")]), "partially_applied");
});

test("uncertainty resolved by later reconciliation stops counting as unknown", () => {
  const before = [op("a", "completed"), op("b", "uncertain")];
  assert.equal(aggregateExternalOutcome(before), "unknown");
  const after = [op("a", "completed"), op("b", "uncertain", { reconciled: "applied" })];
  assert.equal(aggregateExternalOutcome(after), "applied");
});

test("a failed operation completed by a repair counts as applied", () => {
  assert.equal(aggregateExternalOutcome([op("a", "completed"), op("b", "failed", { ledger: "completed" })]), "applied");
});

test("legacy and command effects aggregate the same way", () => {
  const legacy: EffectEvidence = { execution: { protocol: "legacy", invocationId: "inv-1" }, stage: "s0", occurrence: "x", recorded: "completed" };
  assert.equal(aggregateExternalOutcome([legacy, op("b", "failed")]), "partially_applied");
});
