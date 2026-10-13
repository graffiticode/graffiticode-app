#!/usr/bin/env node

// Manual check for free-plan session/workspace token handling
// (npx tsx scripts/check-free-plan-session.ts). No Firestore, no network — just
// the token contract and the header-resolution rules. The repo has no unit-test
// runner, and these are the properties it would be expensive to get wrong.

process.env.FREE_PLAN_NAMESPACE_SALT = "test-salt-not-a-real-secret";

import {
  mintSessionToken,
  verifySessionToken,
  looksLikeSessionToken,
} from "../src/lib/free-plan-session-token";
import { mintClaimToken, verifyClaimToken } from "../src/lib/claim-token";
import { isFreePlanRequest, deriveSessionNamespace } from "../src/lib/free-plan-context";
import { adoptSiblingWorkspace } from "../src/lib/workspace-adoption";
import { emitEvent } from "../src/lib/funnel-events";

let bad = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}
async function throws(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(label, false, "expected a throw, got success");
  } catch {
    check(label, true);
  }
}

const req = (session?: string) => ({ headers: session ? { "x-free-plan-session": session } : {} });

async function main() {
  const NS = "a".repeat(64);
  const UUID = "11111111-2222-3333-4444-555555555555";

  // --- token round trip ---
  const token = await mintSessionToken({ sessionNamespace: NS, sessionUuid: UUID });
  check("session token round-trips", (await verifySessionToken(token)).sessionNamespace === NS);
  check("session token is detectable by shape", looksLikeSessionToken(token));
  check("a uuid is not mistaken for a token", !looksLikeSessionToken(UUID));

  // --- audiences are not interchangeable ---
  // Both are HS256 under the same salt, so only the audience separates them. If
  // that check were dropped, a claim token (which rides in a shareable URL)
  // would be usable as a workspace credential.
  const claim = await mintClaimToken({ sessionNamespace: NS, sessionUuid: UUID });
  await throws("claim token rejected as a session token", () => verifySessionToken(claim));
  await throws("session token rejected as a claim token", () => verifyClaimToken(token));

  // --- header resolution ---
  const signed = await isFreePlanRequest(req(token));
  check(
    "signed header yields the token's namespace, not a hash of the token",
    signed.freePlan === true && (signed as any).sessionNamespace === NS,
  );
  const rawResolved = await isFreePlanRequest(req(UUID));
  check(
    "raw uuid header still derives (compat mode)",
    rawResolved.freePlan === true &&
      (rawResolved as any).sessionNamespace === deriveSessionNamespace(UUID),
  );
  check("no header is not a free-plan request", (await isFreePlanRequest(req())).freePlan === false);

  // A corrupted token must NOT silently fall back to being hashed as a uuid —
  // that would let anyone downgrade to the forgeable path by flipping a byte.
  await throws("tampered token is rejected, not downgraded", () =>
    isFreePlanRequest(req(token.slice(0, -3) + "xxx")),
  );

  // --- the Stage 3 switch ---
  process.env.FREE_PLAN_REQUIRE_SIGNED_SESSION = "true";
  await throws("raw uuid rejected once signed sessions are required", () =>
    isFreePlanRequest(req(UUID)),
  );
  check(
    "signed token still accepted when signed sessions are required",
    (await isFreePlanRequest(req(token))).freePlan === true,
  );
  delete process.env.FREE_PLAN_REQUIRE_SIGNED_SESSION;

  // --- unsalted-hash regression ---
  // A missing salt used to yield a globally predictable namespace while looking
  // like it worked; anyone could compute it and read the items inside.
  const salt = process.env.FREE_PLAN_NAMESPACE_SALT;
  delete process.env.FREE_PLAN_NAMESPACE_SALT;
  try {
    deriveSessionNamespace(UUID);
    check("missing salt throws instead of hashing unsalted", false);
  } catch {
    check("missing salt throws instead of hashing unsalted", true);
  }
  process.env.FREE_PLAN_NAMESPACE_SALT = salt;

  // --- sibling workspace adoption ---
  // A create names no item of its own, so without this a client that mints a
  // fresh session per tool call opens a new workspace per item and no single
  // claim link can save the conversation.
  const OTHER = "b".repeat(64);
  const live = { sessionNamespace: OTHER, expiresAt: Date.now() + 60_000 };

  const joins = { freePlan: true, sessionNamespace: NS };
  adoptSiblingWorkspace(joins, live);
  check("adopts a live sibling's workspace", joins.sessionNamespace === OTHER);

  const same = { freePlan: true, sessionNamespace: OTHER };
  adoptSiblingWorkspace(same, live);
  check("no-ops when already in the sibling's workspace", same.sessionNamespace === OTHER);

  // An aged-out item is not a workspace to join, exactly as it is not one to read.
  const viaExpired = { freePlan: true, sessionNamespace: NS };
  adoptSiblingWorkspace(viaExpired, { sessionNamespace: OTHER, expiresAt: Date.now() - 1 });
  check("declines an expired sibling", viaExpired.sessionNamespace === NS);

  // Authenticated callers have a durable identity and must never be rebound.
  const signedIn = { freePlan: false, sessionNamespace: NS };
  adoptSiblingWorkspace(signedIn, live);
  check("ignores a sibling for an authenticated caller", signedIn.sessionNamespace === NS);

  const noOwner = { freePlan: true, sessionNamespace: NS };
  adoptSiblingWorkspace(noOwner, { expiresAt: Date.now() + 60_000 });
  check("declines a sibling with no workspace of its own", noOwner.sessionNamespace === NS);

  // --- lang never carries a prompt into the logs ---
  // emitEvent normalizes `lang` centrally because the call sites kept passing the
  // raw `language` tool argument, which is free text. buildScopeError is the
  // sharpest case: it fires when the language was NOT recognised, so its value is
  // the one most likely to be a description.
  const emitted = (fields: Record<string, unknown>) => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (s: string) => void lines.push(s);
    try {
      emitEvent("wall_hit", fields as any);
    } finally {
      console.log = orig;
    }
    return JSON.parse(lines[0] ?? "{}");
  };

  const leak = emitted({ wall: "language_scope", lang: "create a green bar chart using mock data" });
  check("a prompt in `lang` is replaced, not logged", leak.lang === "(invalid)");
  check("and no fragment of it survives", !JSON.stringify(leak).includes("bar chart"));

  const long = emitted({ wall: "language_scope", lang: "make me a quiz about ".repeat(40) });
  check("a long prompt is not merely truncated to 200 chars", long.lang === "(invalid)");

  check("real ids still pass through canonically", emitted({ lang: "0173" }).lang === "L0173");
  check("case and prefix variants converge", emitted({ lang: "l0173" }).lang === "L0173");
  check("an absent lang stays absent", emitted({ wall: "item_limit" }).lang === undefined);

  console.log(bad ? `\n${bad} failure(s)` : "\nall ok");
  process.exit(bad ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
