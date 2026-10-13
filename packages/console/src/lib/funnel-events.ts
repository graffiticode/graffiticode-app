// Structured funnel events emitted to stdout → Cloud Logging.
//
// One JSON line per lifecycle event. Read back with:
//   gcloud logging read 'jsonPayload.ev="item_created"' \
//     --project graffiticode-app --format json
// and aggregated hourly by src/lib/funnel-digest.ts (SMS) and out-of-band by
// scripts/mcp-funnel-report.ts (HTML).
//
// This is the console-side twin of graffiticode-mcp-server/src/events.ts and
// shares its schema and privacy contract:
//   - never log prompts, item source, or free-text descriptions — only lengths
//   - never log raw session uuids, bearer tokens, emails, or wallet addresses
//   - never log the client IP
//
// The `session` field is the join key across all three emitters (console,
// mcp-service, app.graffiticode.org). For free-plan traffic it is the
// `sessionNamespace` the console already stamps on items; for authenticated
// traffic it is a one-way hash of the uid. That keeps "how many distinct
// actors" answerable without any identifier leaving the process.

import crypto from "crypto";

/**
 * Headline events get their own line in the hourly SMS digest; context events
 * are folded into its trailing summary line. The split itself lives in
 * src/lib/funnel-digest.ts — this type only enumerates what may be emitted.
 */
export type FunnelEventName =
  // headline
  | "item_created"
  | "wall_hit"
  | "api_key_created"
  | "signup"
  | "plan_changed"
  // First card on file: a hard-capped tier enrolling in pay-as-you-go. Headline
  // because it is the conversion moment on the free tier — the plan id doesn't
  // move, so plan_changed can never report it.
  | "payg_enabled"
  | "overage_limit_raised"
  // A request whose PROMPT was not written in English. Headline because it is
  // demand we are currently unable to serve, and the only record of it: the
  // request is refused before an item exists, so item_created/item_updated
  // never fire for one.
  //
  // Emitted in BOTH shadow and enforce mode (see NON_ENGLISH_GATE), carrying
  // `blocked` to tell them apart. That is the point — during the shadow window
  // nothing is refused, so a wall_hit would report zero for exactly the period
  // the measurement exists to cover.
  | "non_english_request"
  // The scope gate refusing a fresh create outright — inScope=false with no
  // routedLang, i.e. "no language we have fits this". It is the ONE wall that was
  // counted nowhere: `language_scope` in the wall taxonomy is the free-plan
  // allow-list, a different thing, and the reject path emitted nothing at all.
  //
  // It is worth counting because it is a DEMAND signal, not just a failure. Every
  // refusal in the 30 days to 2026-09-05 named a capability that then got built,
  // usually within hours: L0180's `order` interaction (refused 09-04 20:06 UTC,
  // added 09-04 19:33), generic MCQ (refused 08-31, L0180 registered 08-31), a
  // Data API query (refused 08-13, L0178 registered 08-13). Read as a backlog,
  // these say what someone asked for that the catalog could not answer yet.
  //
  // Carries `lang` and the coarse shape only — never the reason text, which is
  // model prose about the request and can quote it. The reason stays in the
  // `[routing] preflight.reject` log line for a human.
  | "out_of_scope_request"
  // context
  | "item_updated"
  | "item_generation_failed"
  // Per-stage timing for one generateCodeForRequest run. Context, and read by
  // nothing in the digest — it exists so the MCP path's latency is attributable.
  //
  // The MCP path runs a pipeline (route → retrieve → plan → compose → generate →
  // parse → repair) where the console UI runs the generate step alone, and it
  // showed: worker p50 was 23.8s against a console UI that returns in under 10s,
  // and 29% of runs exceeded the MCP server's 45s poll deadline, which is what
  // makes render_item return "still generating" and the agent call again. No
  // per-stage timing existed, so which stage owns that gap was unanswerable.
  //
  // Durations only — never prompt text, never source. See the contract at the
  // top of this file.
  | "item_generation_timing"
  | "checkout_started"
  | "free_plan_budget";

export type FunnelAuth = "freePlan" | "firebase";

export interface FunnelEventFields {
  auth?: FunnelAuth;
  /** sessionNamespace (free-plan) or sha256(uid) (authenticated). */
  session?: string;
  lang?: string;
  /** Source surface: "console" | "mcp" | "front". */
  app?: string;
  /** First billable item ever for this account. */
  first_for_account?: boolean;
  /**
   * wall_hit: which limit was hit. Free-form — funnel-digest buckets by the
   * string, so a new wall needs no change there.
   *
   * "request_token_budget" is the odd one out: it is a circuit breaker, not a
   * limit a customer can raise by upgrading, and unlike non_english_request it
   * is emitted ONLY when a request was actually refused. In shadow mode the
   * signal is the `[budget]` log line instead — a wall counter that also counted
   * would-be refusals would misreport how many users hit a wall.
   */
  wall?: string;
  /**
   * non_english_request: the NATURAL language of the prompt — a dominant script
   * name ("cyrillic"), or a language tag ("fr") when marker words identified
   * one. See src/lib/prompt-language.ts on why the granularity is mixed.
   *
   * These are deliberately NOT `lang`, which is normalized through langKey()
   * below and means the Graffiticode dialect: langKey("ru") is "(invalid)".
   */
  script?: string;
  plang?: string;
  /** non_english_request: whether the gate actually refused it. */
  blocked?: boolean;
  /** signup: whether the account was born from a claim link or on its own. */
  via?: "claim" | "direct";
  /** plan_changed: internal plan ids, e.g. "demo" → "pro". */
  from?: string;
  to?: string;
  reason?: string;
  err?: string;
  [key: string]: unknown;
}

/**
 * One-way hash of an authenticated uid. Firebase uids here are often wallet
 * addresses, which are publicly linkable, so they never reach the log.
 */
export function hashUid(uid: string): string {
  return crypto.createHash("sha256").update(uid).digest("hex");
}

/**
 * Build the `{ auth, session }` pair every event carries. Accepts whatever the
 * call site happens to have: an auth context with a uid, a free-plan session
 * namespace, or neither.
 */
export function actor(input: {
  uid?: string | null;
  sessionNamespace?: string | null;
  freePlan?: boolean;
}): { auth: FunnelAuth; session: string } | Record<string, never> {
  // Free-plan callers all share the trial account's uid, so the namespace is
  // the only field that distinguishes one anonymous session from another.
  if (input.freePlan && input.sessionNamespace) {
    return { auth: "freePlan", session: input.sessionNamespace };
  }
  if (input.uid) {
    return { auth: "firebase", session: hashUid(input.uid) };
  }
  if (input.sessionNamespace) {
    return { auth: "freePlan", session: input.sessionNamespace };
  }
  return {};
}

/**
 * Normalize a language to its canonical "L0166" form.
 *
 * Lives here, on the request path, so the workspace registry and the reports
 * bucket a language the same way. The MCP server strips the `L` prefix before
 * calling us, so without one shared normalizer the registry's `lang` and the
 * log-derived language tables disagree about the same call.
 *
 * Anything that isn't an L-number becomes "(invalid)" rather than passing
 * through. Clients do send junk: a real week had a call whose `language`
 * argument was "create a green bar chart using mock data", which a pass-through
 * turned into its own 40-character row in the language table.
 */
export function langKey(v: unknown): string | undefined {
  if (typeof v !== "string" || !v) return undefined;
  const t = v.trim();
  if (/^\d{2,6}$/.test(t)) return `L${t}`;
  if (/^L\d{2,6}$/i.test(t)) return t.toUpperCase();
  return "(invalid)";
}

/**
 * Report a subscription plan transition.
 *
 * Emit this at the point our OWN state changes — the `users/{uid}` plan write —
 * never per Stripe webhook type. A single upgrade delivers
 * checkout.session.completed + customer.subscription.created +
 * customer.subscription.updated + invoice.paid, and every one of them lands on
 * the same plan write. Guarding on `from !== to` collapses them to one event and
 * makes the in-app path (quick-subscribe) and the webhook path idempotent with
 * respect to each other, whichever runs first.
 *
 * The guard is skipped for explicit customer actions ("I want to cancel"), which
 * are real decisions even though the plan value hasn't moved yet.
 */
export function emitPlanChanged(input: {
  uid: string;
  from?: string | null;
  to?: string | null;
  reason: "subscription_sync" | "cancel_requested" | "resume_requested";
}): void {
  const from = input.from ?? undefined;
  const to = input.to ?? undefined;
  if (input.reason === "subscription_sync" && from === to) return;
  emitEvent("plan_changed", {
    ...actor({ uid: input.uid }),
    from,
    to,
    reason: input.reason,
  });
}

/**
 * Emit one event. Best-effort by contract: instrumentation must never break a
 * request, so every failure — including a serialization cycle — is swallowed.
 */
export function emitEvent(
  ev: FunnelEventName,
  fields: FunnelEventFields = {},
): void {
  try {
    const payload: Record<string, unknown> = {
      ev,
      t: new Date().toISOString(),
    };
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      // `lang` is normalized HERE rather than at each call site, because the
      // call sites kept forgetting: item_created, item_updated,
      // item_generation_failed and wall_hit all passed the raw `language` tool
      // argument straight through. That argument is free text, so prompts
      // reached the logs — and buildScopeError is the worst offender, since it
      // fires exactly when the language was NOT recognised, which is precisely
      // when the value is most likely to be a description. Truncating to 200
      // chars is not a defence; the value has to be replaced, not shortened.
      if (key === "lang") {
        const normalized = langKey(value);
        if (normalized !== undefined) payload[key] = normalized;
        continue;
      }
      payload[key] = typeof value === "string" ? value.slice(0, 200) : value;
    }
    console.log(JSON.stringify(payload));
  } catch {
    // ignore
  }
}
