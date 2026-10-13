import assert from "node:assert/strict";
import test from "node:test";
import {
  FreePlanLimitError,
  buildFreePlanLimitText,
  parseFreePlanError,
  parseFreePlanErrorBody,
} from "../src/free-plan-limit.js";

// Payloads in the exact shapes the console emits (console/src/lib/free-plan-throttle.ts,
// free-plan-quota.ts): the request gate's HTTP body, and GraphQL extensions.
const BURST_BODY = JSON.stringify({
  error: "free_plan_rate_limit_exceeded",
  message:
    "The Graffiticode free plan allows 120 requests every 60 seconds. Please retry in 42s, " +
    "or create a free account at graffiticode.org/signup to remove this limit.",
  retry_after_seconds: 42,
  signup_url: "https://graffiticode.org/signup?utm_source=free_plan&utm_medium=rate_limit",
});

test("an HTTP 429 burst body parses into a typed limit", () => {
  const err = parseFreePlanErrorBody(BURST_BODY);
  assert.ok(err instanceof FreePlanLimitError);
  assert.equal(err.code, "free_plan_rate_limit_exceeded");
  assert.equal(err.retryAfterSeconds, 42);
  assert.equal(err.isLimit, true);
});

test("GraphQL extensions (code, not error) parse too", () => {
  const err = parseFreePlanError({
    code: "free_plan_daily_limit_reached",
    status: 429,
    error: "free_plan_daily_limit_reached",
    message: "The Graffiticode free plan has reached its item limit for today and resumes tomorrow UTC.",
  });
  assert.equal(err?.code, "free_plan_daily_limit_reached");
  assert.equal(err?.retryAfterSeconds, undefined);
});

test("the limit text names Graffiticode, links signup, and says not to retry", () => {
  const text = buildFreePlanLimitText(parseFreePlanErrorBody(BURST_BODY)!);
  assert.match(text, /^\*\*Graffiticode free-plan limit reached\*\*/);
  assert.match(text, /not of this chat app/);
  assert.match(text, /\]\(https:\/\/graffiticode\.org\/signup\?utm_source=free_plan&utm_medium=rate_limit\)/);
  assert.match(text, /Do not retry automatically/);
  assert.match(text, /at least 42 seconds/);
  assert.doesNotMatch(text, /[{}]/, "no raw JSON reaches the model");
});

test("a limit with no retry time says not to retry at all", () => {
  const err = parseFreePlanError({ error: "free_plan_item_limit_reached", message: "Monthly item limit reached." })!;
  assert.match(buildFreePlanLimitText(err), /Do not retry\. Tell the user/);
});

test("an input rejection is not dressed up as a limit", () => {
  const err = parseFreePlanError({ code: "free_plan_description_too_long", message: "Too long." })!;
  assert.equal(err.isLimit, false);
  const text = buildFreePlanLimitText(err);
  assert.doesNotMatch(text, /limit reached/);
  assert.match(text, /Too long\./);
});

test("non-free-plan and message-less payloads fall through to the generic path", () => {
  assert.equal(parseFreePlanErrorBody("<html>502</html>"), null);
  assert.equal(parseFreePlanError({ error: "something_else", message: "x" }), null);
  assert.equal(parseFreePlanError({ error: "free_plan_session_invalid" }), null);
  assert.equal(parseFreePlanError(undefined), null);
});

test("a GraphQL error's own message backs a payload that lacks one", () => {
  const err = parseFreePlanError({ code: "free_plan_revision_limit_reached" }, "This item has reached 20 revisions.");
  assert.equal(err?.detail, "This item has reached 20 revisions.");
});

test("a non-https signup url is ignored in favour of the default", () => {
  const err = parseFreePlanError({ error: "free_plan_item_limit_reached", message: "m", signup_url: "javascript:x" })!;
  assert.equal(err.signupUrl, undefined);
  assert.match(buildFreePlanLimitText(err), /\(https:\/\/graffiticode\.org\/signup/);
});
