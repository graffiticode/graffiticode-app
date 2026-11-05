import assert from "node:assert/strict";
import test from "node:test";
import { FreePlanError } from "@graffiticode-app/core/lib/free-plan-context";
import { asGraphqlError } from "../src/core-backend.js";
import { FreePlanLimitError, buildFreePlanLimitText } from "../src/free-plan-limit.js";

// 2026-11-05: an oversized free-plan create_item was refused correctly, but the agent
// saw "GraphQL error: Failed to create item: …" — core wraps a refused create and
// keeps the FreePlanError as `cause`, which this mapping didn't read.

const tooLong = () =>
  new FreePlanError("free_plan_description_too_long", 400, {
    error: "free_plan_description_too_long",
    message: "This request plus the recent conversation is 10779 characters, over the 10000-character free-plan limit.",
  });

test("a free-plan refusal wrapped by a create keeps its own wording", () => {
  const wrapped = new Error(`Failed to create item: ${tooLong().message}`);
  (wrapped as Error & { cause?: unknown }).cause = tooLong();
  const mapped = asGraphqlError(wrapped);
  assert.ok(mapped instanceof FreePlanLimitError);
  assert.equal((mapped as FreePlanLimitError).code, "free_plan_description_too_long");
  assert.match(buildFreePlanLimitText(mapped as FreePlanLimitError), /^Graffiticode rejected this request: This request plus/);
});

test("an unwrapped free-plan refusal (an update) maps the same way", () => {
  assert.ok(asGraphqlError(tooLong()) instanceof FreePlanLimitError);
});

test("an ordinary failure, wrapped or not, stays a generic error", () => {
  const wrapped = new Error("Failed to create item: boom");
  (wrapped as Error & { cause?: unknown }).cause = new Error("boom");
  const mapped = asGraphqlError(wrapped);
  assert.ok(!(mapped instanceof FreePlanLimitError));
  assert.equal(mapped.message, "GraphQL error: Failed to create item: boom");
});
