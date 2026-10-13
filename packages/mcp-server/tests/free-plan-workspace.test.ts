import assert from "node:assert/strict";
import test from "node:test";
import { deriveSessionNamespace, namespaceForSession } from "../src/claim-token.js";
import { effectiveSession } from "../src/events.js";
import { captureWorkspace, captureWorkspaceNamespace, type AuthContext } from "../src/api.js";
import { mintSessionToken } from "../src/session-token.js";

const UUID = "11111111-2222-3333-4444-555555555555";
const NS = "b".repeat(64);

// A signed workspace token as the console issues it. Only the payload matters
// here — namespaceForSession deliberately does not verify the signature, because
// it labels telemetry rather than authorizing anything.
function fakeToken(payload: Record<string, unknown>): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${seg({ alg: "HS256" })}.${seg(payload)}.signature`;
}

test("event sessions resolve to the workspace namespace, not a hash of the token", () => {
  // The regression this guards: X-Free-Plan-Session used to be a raw uuid, so
  // events hashed it. Once the console starts handing back signed workspace
  // tokens, hashing THAT yields a value unrelated to the workspace it names —
  // silently breaking the funnel report's join between MCP events and console
  // items on sessionNamespace.
  const token = fakeToken({ sessionNamespace: NS, sessionUuid: UUID });
  assert.equal(namespaceForSession(token), NS);
  assert.notEqual(namespaceForSession(token), deriveSessionNamespace(token));
});

test("a raw session uuid is still hashed the way the console hashes it", () => {
  assert.equal(namespaceForSession(UUID), deriveSessionNamespace(UUID));
});

test("an unreadable token falls back to hashing rather than throwing", () => {
  // Telemetry must never be able to fail a tool call.
  assert.equal(namespaceForSession("a.b.c"), deriveSessionNamespace("a.b.c"));
  const noNamespace = fakeToken({ sessionUuid: UUID });
  assert.equal(namespaceForSession(noNamespace), deriveSessionNamespace(noNamespace));
});

test("a returned workspace handle supersedes the transport session", () => {
  // This is what keeps a client in one workspace across the transport sessions
  // it keeps losing (restart, scale-out, ChatGPT's per-tool-call sessions).
  let stored: string | null = null;
  const auth: AuthContext = {
    type: "freePlan",
    sessionId: UUID,
    onWorkspace: (t) => { stored = t; },
  };
  const token = fakeToken({ sessionNamespace: NS, sessionUuid: UUID });

  captureWorkspace(auth, { workspace: token });
  assert.equal(stored, token);
});

test("responses without a workspace leave the session untouched", () => {
  let stored: string | null = null;
  const auth: AuthContext = {
    type: "freePlan",
    sessionId: UUID,
    onWorkspace: (t) => { stored = t; },
  };
  captureWorkspace(auth, { workspace: null });
  captureWorkspace(auth, null);
  assert.equal(stored, null);
});

test("the minted session token matches the console's verifier contract", async () => {
  // This is the ONLY signing contract still duplicated across the two repos
  // (claim tokens moved wholly to the console). The console verifies audience,
  // algorithm and both payload claims; if any of them drift, every free-plan
  // session breaks the moment FREE_PLAN_REQUIRE_SIGNED_SESSION is enabled.
  // See console/src/lib/free-plan-session-token.ts.
  const token = await mintSessionToken(UUID);
  assert.ok(token, "expected a token — is FREE_PLAN_NAMESPACE_SALT set for tests?");

  const [rawHeader, rawPayload] = token!.split(".");
  const header = JSON.parse(Buffer.from(rawHeader, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(rawPayload, "base64url").toString("utf8"));

  assert.equal(header.alg, "HS256");
  assert.equal(payload.aud, "graffiticode-session");
  assert.equal(payload.sessionUuid, UUID);
  assert.equal(payload.sessionNamespace, deriveSessionNamespace(UUID));
  // 48h, matching the console's free-plan item TTL: a workspace handle must not
  // outlive the items it addresses.
  assert.equal(payload.exp - payload.iat, 48 * 60 * 60);
});

test("session tokens are distinguishable from the raw uuid they replace", async () => {
  const token = await mintSessionToken(UUID);
  assert.equal(token!.split(".").length, 3);
  assert.equal(UUID.split(".").length, 1);
});

test("authenticated callers never adopt a workspace", () => {
  // Belt and braces: the console does not emit `workspace` for authenticated
  // callers, but an authenticated session must not be rebindable regardless.
  const auth: AuthContext = { type: "firebase", token: "id-token" };
  assert.doesNotThrow(() => captureWorkspace(auth, { workspace: fakeToken({ sessionNamespace: NS }) }));
});

// --- what the funnel labels a call with -------------------------------------
// `session` is supposed to name the WORKSPACE and `tns` the transport, so a join
// on tns survives the drift between them (see src/events.ts). That drift never
// actually appeared: startCodeGeneration reported no workspace, so session was
// always the transport's own namespace and the two fields were identical on
// every event ever emitted. These cover the reporting seam that fixes it.

test("a reported workspace namespace becomes the event's session", () => {
  const auth: AuthContext = { type: "freePlan", sessionId: UUID };
  // Deliberately NOT NS: if the adopted value equalled the fallback, this would
  // pass whether or not effectiveSession preferred it.
  const adopted = "d".repeat(64);
  assert.notEqual(adopted, NS);
  captureWorkspaceNamespace(auth, { workspaceNamespace: adopted });
  assert.equal(auth.effectiveNamespace, adopted);
  assert.equal(effectiveSession(auth, NS), adopted);
});

test("without one, the event keeps the namespace we derived ourselves", () => {
  const auth: AuthContext = { type: "freePlan", sessionId: UUID };
  captureWorkspaceNamespace(auth, { workspaceNamespace: null });
  captureWorkspaceNamespace(auth, null);
  assert.equal(auth.effectiveNamespace, undefined);
  assert.equal(effectiveSession(auth, NS), NS);
});

test("an authenticated caller is never relabelled", () => {
  // A bearer session is keyed by its token hash; there is no anonymous workspace
  // to adopt, and rewriting its session would break the firebase funnel.
  const auth: AuthContext = { type: "firebase", token: "tok" };
  captureWorkspaceNamespace(auth, { workspaceNamespace: "c".repeat(64) });
  assert.equal(effectiveSession(auth, NS), NS);
});
