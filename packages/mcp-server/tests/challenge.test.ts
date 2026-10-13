import assert from "node:assert/strict";
import test from "node:test";
import { buildChallengeResponse } from "../src/challenge.js";

test("challenge returns the exact token and nothing else when set", () => {
  const r = buildChallengeResponse("abc123-openai-token");
  assert.equal(r.status, 200);
  assert.equal(r.body, "abc123-openai-token");
  assert.equal(r.headers["Content-Type"], "text/plain; charset=utf-8");
  assert.equal(r.headers["Cache-Control"], "no-store");
});

test("challenge is inert (404) when the token env var is unset", () => {
  const r = buildChallengeResponse(undefined);
  assert.equal(r.status, 404);
  assert.doesNotMatch(r.body, /token/i);
});

test("empty-string token is treated as unset", () => {
  assert.equal(buildChallengeResponse("").status, 404);
});
