import assert from "node:assert/strict";
import test from "node:test";
import { redactEmails } from "../src/oauth/handlers.js";

// Refusal messages are logged at the token endpoint; they must never carry an email.

test("emails are redacted before anything is logged", () => {
  assert.equal(redactEmails("no account for jane.doe+x@example.co.uk, sorry"), "no account for <email>, sorry");
  assert.equal(redactEmails("No Graffiticode account for this email."), "No Graffiticode account for this email.");
});
