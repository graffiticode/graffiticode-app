import assert from "node:assert/strict";
import test from "node:test";
import { pollNapMs } from "../src/tools.js";

// The bug this pins, from the 2026-09-04 profile of an L0000 "multiply 10 and 21":
// the loop's third check ended 1,551ms before the 8s deadline, slept a full 2,500ms
// interval, and made a fourth check 949ms PAST the deadline. That check saw a READY
// item and reported "still generating", because the deadline branch had no budget
// left to fetch data with — costing the caller an entire extra round trip.
test("a sleep never runs past the deadline", () => {
  assert.equal(pollNapMs(1_551, 2_500), 1_551, "clamps to the remaining budget");
  assert.equal(pollNapMs(5_000, 1_000), 1_000, "uses the interval when it fits");
  assert.equal(pollNapMs(1_000, 1_000), 1_000, "exact fit is allowed");
});

test("stops when another check cannot pay for itself", () => {
  // An upstream check costs ~480ms; below the floor the answer arrives too late to use.
  assert.equal(pollNapMs(599, 1_000), null);
  assert.equal(pollNapMs(0, 1_000), null);
  assert.equal(pollNapMs(-949, 2_500), null, "the profiled overshoot is refused outright");
  assert.equal(pollNapMs(600, 1_000), 600, "at the floor a check is still worth making");
});

test("the floor is a parameter, not a constant baked into callers", () => {
  assert.equal(pollNapMs(300, 1_000, 200), 300);
  assert.equal(pollNapMs(300, 1_000, 400), null);
});
