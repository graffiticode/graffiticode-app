import assert from "node:assert/strict";
import test from "node:test";
import { redactEmails, refusalMessage } from "../src/oauth/handlers.js";

// 2026-10-01: a Google sign-in for an email with no Graffiticode account reached /oauth/token,
// the auth service refused it with a clear message, and the token endpoint answered 500
// server_error. It now answers 400 invalid_grant carrying that message; these pin the parts
// that read and log it.

test("the auth service's refusal message is read from its JSON envelope", () => {
  const body = JSON.stringify({
    status: "error",
    error: { code: 401, message: "No Graffiticode account for this email. Sign in at console.graffiticode.org first, then reconnect." },
    data: null,
  });
  assert.equal(refusalMessage(body), "No Graffiticode account for this email. Sign in at console.graffiticode.org first, then reconnect.");
});

test("a plain-text or empty refusal still yields a message", () => {
  assert.equal(refusalMessage("Forbidden"), "Forbidden");
  assert.equal(refusalMessage(""), "Sign-in was refused.");
  assert.equal(refusalMessage(JSON.stringify({ error: "account disabled" })), "account disabled");
});

test("emails are redacted before anything is logged", () => {
  assert.equal(redactEmails("no account for jane.doe+x@example.co.uk, sorry"), "no account for <email>, sorry");
  assert.equal(redactEmails("No Graffiticode account for this email."), "No Graffiticode account for this email.");
});
