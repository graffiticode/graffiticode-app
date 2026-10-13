import { getFirestore } from "../utils/db";
import { FreePlanError, buildSignupUrl } from "./free-plan-context";
import { emitEvent } from "./funnel-events";

// Anonymous free-plan (MCP trial) quota, denominated in ITEMS to match the rest
// of the product (docs/item-based-pricing.md). Replaces the old per-token dollar
// circuit breaker, which metered a unit nothing else in the system used and
// needed a per-model price table to stay honest.
//
// Three limits, three jobs:
//   - per-item revisions   -> plans-config trialItemRevisionLimit(), enforced in resolvers
//   - monthly items        -> the trial account's OWN plan allowance, enforced by
//                             checkItemCreateAllowed (overageLimitItems: 0 makes it hard)
//   - daily items          -> derived here from what's left of the month
//
// Nothing here is session-scoped. An MCP "session" is an in-memory transport
// binding that ChatGPT re-mints per tool call and that dies whenever Cloud Run
// scales or restarts, so session-keyed quota silently does nothing for the
// clients that matter. These counters live in Firestore and outlive all of that.

const db = getFirestore();

function todayKey(now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function dailyDocRef(now = new Date()) {
  return db.collection("free-plan-state").doc(`items-${todayKey(now)}`);
}

function nextUtcMidnightIso(now = new Date()): string {
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0,
  ));
  return next.toISOString();
}

/** UTC days from `now` to the end of the budget period, counting today. */
function daysRemainingInPeriod(periodEnd: Date | undefined, now: Date): number {
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysUntil = (end: Date) =>
    Math.floor(
      (Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()) - startOfToday) / 86_400_000,
    ) + 1;

  // Calendar month end, mirroring checkItemCreateAllowed's period-start
  // fallback, so an account with no Stripe period still paces.
  const calendarEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));

  if (!periodEnd) return Math.max(1, daysUntil(calendarEnd));

  const days = daysUntil(periodEnd);
  // A period end in the past means the subscription doc is stale (a lagging
  // renewal webhook, most likely), not that the budget is due in one day.
  // Collapsing to 1 there would hand the whole month's allowance to a single
  // day and, because the doc stays stale, keep doing it — pacing would quietly
  // switch itself off. Fall back to the calendar month instead.
  if (days < 1) return Math.max(1, daysUntil(calendarEnd));
  return days;
}

/**
 * Today's item allowance: what's left of the period's budget, spread evenly over
 * the days left in it.
 *
 * Self-balancing by construction — day 1 of a 30-day period with 1,000 included
 * is ceil(1000/30) = 34; if only 10 land, day 2 is ceil(990/29) = 35. A heavy day
 * tightens the days that follow instead of stranding the rest of the month, and
 * the budget can never go dark mid-period the way a flat daily cap does.
 *
 * ceil, not floor, so a small remainder near the end of the period isn't
 * stranded at zero (5 items over 10 days must allow 1/day, not 0).
 */
export function dailyItemAllowance({
  includedItems,
  currentPeriodTotal,
  periodEnd,
  now = new Date(),
}: {
  includedItems: number;
  currentPeriodTotal: number;
  periodEnd?: Date;
  now?: Date;
}): number {
  const remaining = Math.max(0, includedItems - currentPeriodTotal);
  if (remaining === 0) return 0;
  return Math.ceil(remaining / daysRemainingInPeriod(periodEnd, now));
}

/**
 * Record LLM spend for the day. Telemetry only — the budget is items, and
 * nothing reads this to allow or refuse a request.
 *
 * It exists because cost-per-acquired-account is a funnel metric
 * (scripts/mcp-funnel-report.ts reads these docs). Deleting the dollar cap
 * removed the writer as well as the control, which would have left that metric
 * reading $0 forever — indistinguishable from "we spend nothing".
 */
export async function recordSpend(usd: number, now = new Date()): Promise<void> {
  if (!Number.isFinite(usd) || usd <= 0) return;
  const ref = db.collection("free-plan-state").doc(`spend-${todayKey(now)}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.exists ? Number(snap.data()?.usd) : 0;
    const next = (Number.isFinite(prev) ? prev : 0) + usd;
    tx.set(ref, { usd: next, updated: now.toISOString() }, { merge: true });
  });
}

export async function getTodayItemCount(now = new Date()): Promise<number> {
  const snap = await dailyDocRef(now).get();
  if (!snap.exists) return 0;
  const count = Number(snap.data()?.count);
  return Number.isFinite(count) ? count : 0;
}

/** Increment today's trial item counter. Best-effort; called after a successful create. */
export async function recordTrialItem(now = new Date()): Promise<void> {
  const ref = dailyDocRef(now);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.exists ? Number(snap.data()?.count) : 0;
    const next = (Number.isFinite(prev) ? prev : 0) + 1;
    tx.set(ref, { count: next, updated: now.toISOString() }, { merge: true });
  });
}

// Every message below is self-contained on purpose: only the string propagates
// back through the MCP tool result, so each has to carry its own recovery path.
//
// Each builder emits its `wall_hit` event: every one is called directly inside a
// `throw`, so the builder is the one choke point that can't drift as call sites
// move. The trade-off is that a builder has no auth context, so a wall is
// counted by kind but not attributed to a session — which is all the hourly
// digest reports.

export function buildMonthlyQuotaError(itemsUsed?: number, itemsLimit?: number): FreePlanError {
  emitEvent("wall_hit", { wall: "item_limit", auth: "freePlan" });
  return new FreePlanError("free_plan_item_limit_reached", 429, {
    error: "free_plan_item_limit_reached",
    message:
      "The Graffiticode free plan has reached its item limit for this month. " +
      "Create a free account at graffiticode.org/signup to keep creating items.",
    items_used: itemsUsed,
    items_limit: itemsLimit,
    signup_url: buildSignupUrl("item_limit"),
  });
}

export function buildScopeError(lang: string | undefined | null, allowed: string[]): FreePlanError {
  emitEvent("wall_hit", { wall: "language_scope", auth: "freePlan", lang: lang ?? undefined });
  const allowedList = allowed.map((id) => `L${id}`).join(", ");
  return new FreePlanError("language_not_in_trial_scope", 403, {
    error: "language_not_in_trial_scope",
    message:
      `L${String(lang ?? "").replace(/^L/i, "")} is not available on the Graffiticode free plan. ` +
      `Available without an account: ${allowedList}. ` +
      `Create a free account at graffiticode.org/signup to use every language.`,
    language: lang ?? null,
    allowed_languages: allowed,
    signup_url: buildSignupUrl("language_scope"),
  });
}

export function buildItemExpiredError(): FreePlanError {
  emitEvent("wall_hit", { wall: "item_expired", auth: "freePlan" });
  return new FreePlanError("free_plan_item_expired", 410, {
    error: "free_plan_item_expired",
    message:
      "This item has expired. Free-plan items are kept for 48 hours unless they're claimed. " +
      "Create it again, or create a free account at graffiticode.org/signup to keep items permanently.",
    signup_url: buildSignupUrl("item_expired"),
  });
}

export function buildRevisionLimitError(limit: number): FreePlanError {
  emitEvent("wall_hit", { wall: "revision_limit", auth: "freePlan" });
  return new FreePlanError("free_plan_revision_limit_reached", 429, {
    error: "free_plan_revision_limit_reached",
    message:
      `This item has reached the free-plan limit of ${limit} revisions. ` +
      `Create a new item to keep going, or sign in to revise without limit — ` +
      `${buildSignupUrl("revision_limit")}`,
    revisions_limit: limit,
    signup_url: buildSignupUrl("revision_limit"),
  });
}

const ALERT_THRESHOLDS = [50, 80] as const;

/**
 * Warn while there's still budget left to protect.
 *
 * A cap that only announces itself by refusing requests is a cap you find out
 * about from a user. These lines are the signal a Cloud Logging alert policy
 * matches on the `[free-plan] period budget` prefix; keep the prefix stable.
 *
 * Fires once per threshold per period — the flag lives on the period's own doc,
 * so a new billing period naturally re-arms it with no cleanup.
 */
export async function maybeAlertBudget({
  used,
  included,
  periodEnd,
}: {
  used: number;
  included: number;
  periodEnd?: Date;
}): Promise<void> {
  if (!(included > 0)) return;
  const pct = (used / included) * 100;
  const crossed = ALERT_THRESHOLDS.filter((t) => pct >= t);
  if (crossed.length === 0) return;
  const threshold = Math.max(...crossed);

  // Key on the period end so the flags roll over with the billing period.
  const periodKey = (periodEnd ?? new Date()).toISOString().slice(0, 10);
  const ref = db.collection("free-plan-state").doc(`alerts-${periodKey}`);
  try {
    const fired = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const prev = Number(snap.exists ? snap.data()?.threshold : 0) || 0;
      if (prev >= threshold) return false;
      tx.set(ref, { threshold, updated: new Date().toISOString() }, { merge: true });
      return true;
    });
    if (fired) {
      // Keep this prefix stable: an existing Cloud Logging alert policy matches
      // on it. The structured twin below feeds the hourly digest instead; the
      // two are deliberately separate so this doesn't page twice.
      console.log(
        `[free-plan] period budget ${threshold}% — ${used}/${included} items used this period`,
      );
      emitEvent("free_plan_budget", { threshold, used, included });
    }
  } catch (err) {
    // Telemetry must never fail a create.
    console.error("maybeAlertBudget()", "ERROR", err);
  }
}

export function buildDailyPaceError(allowance: number, now = new Date()): FreePlanError {
  emitEvent("wall_hit", { wall: "daily_pace", auth: "freePlan" });
  return new FreePlanError("free_plan_daily_limit_reached", 429, {
    error: "free_plan_daily_limit_reached",
    message:
      "The Graffiticode free plan has reached its item limit for today and resumes tomorrow UTC. " +
      "Create a free account at graffiticode.org/signup for uninterrupted access.",
    items_limit: allowance,
    signup_url: buildSignupUrl("daily_pace"),
    resumes_at: nextUtcMidnightIso(now),
  });
}

/**
 * Throw when today's trial items have hit the derived allowance.
 *
 * Takes the period figures from the caller's existing checkItemCreateAllowed
 * result rather than re-reading the subscription — one Firestore read per create
 * instead of two.
 */
export async function assertWithinDailyPace({
  includedItems,
  currentPeriodTotal,
  periodEnd,
  now = new Date(),
}: {
  includedItems: number;
  currentPeriodTotal: number;
  periodEnd?: Date;
  now?: Date;
}): Promise<void> {
  const allowance = dailyItemAllowance({ includedItems, currentPeriodTotal, periodEnd, now });
  const today = await getTodayItemCount(now);
  if (today >= allowance) {
    throw buildDailyPaceError(allowance, now);
  }
}
