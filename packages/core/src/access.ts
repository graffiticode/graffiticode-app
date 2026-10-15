// Moved from pages/api/resolvers.ts (Phase 1: untangle inside the console).
import { isFreePlanItemExpired } from "./lib/workspace-adoption.js";
import { checkItemCreateAllowed } from "./lib/usage-service.js";
import { emitEvent, actor } from "./lib/funnel-events.js";
import { assertWithinDailyPace, buildMonthlyQuotaError, buildRevisionLimitError, buildScopeError, maybeAlertBudget } from "./lib/free-plan-quota.js";
import { freePlanLanguageIds, isLanguageInFreePlanScope, isLanguageSponsored } from "./lib/languages.js";
import { trialItemRevisionLimit } from "./lib/plans-config.js";
import { db } from "./db.js";
import type { AuthArg } from "./types.js";

export function isItemVisibleToFreePlan(
  data: any,
  auth: AuthArg,
  opts: { byId?: boolean } = {},
  now = Date.now(),
): boolean {
  if (!auth.freePlan) return true;
  // By-id access treats the unguessable item id as the capability (like the public
  // app form page, which renders any item by id): no sessionNamespace match required,
  // only non-expiry. This is what lets a stateless MCP client (ChatGPT opens a new
  // session per tool call) retrieve/refine an item it just created. LISTING still
  // requires the session match, so a session can never enumerate another's items.
  if (!opts.byId && data?.sessionNamespace !== auth.sessionNamespace) return false;
  if (isFreePlanItemExpired(data, now)) return false;
  return true;
}

/**
 * Whether a by-id lookup failed specifically because the item aged out.
 *
 * Worth distinguishing: "not found" tells an agent nothing it can act on, and it
 * will usually retry the same id. "Expired" tells it the content is gone for a
 * knowable reason, with a recovery (recreate, or sign in to keep items) — which
 * is also the moment the 48h TTL is most persuasive as a signup argument.
 */
export function isExpiredForFreePlan(data: any, auth: AuthArg, now = Date.now()): boolean {
  if (!auth.freePlan) return false;
  return isFreePlanItemExpired(data, now);
}

/**
 * Gate item creation against the caller's item budget, throwing when it's spent.
 *
 * One path for everyone. The anonymous trial resolves to a real account with a
 * real subscription (auth.uid is already that account), so its plan allowance IS
 * the trial's monthly budget — no parallel counter, no hardcoded number. Trial
 * callers additionally pace that budget across the billing period so a single
 * day can't burn the month, and they fail CLOSED: there's no tenant to bill and
 * no user to notify if the check itself breaks.
 */
export async function assertItemCreateAllowed(auth: AuthArg, lang?: string): Promise<void> {
  if (auth.freePlan && !isLanguageInFreePlanScope(lang)) {
    throw buildScopeError(lang, freePlanLanguageIds());
  }
  // A sponsored item never counts against the allowance (units: 0), so a wall
  // reached by billable items must not refuse it. Uncapped by decision — a cap
  // would be evaluated against the `sponsorId` rows. The trial keeps its gate:
  // sponsored trial items still count toward pace.
  if (!auth.freePlan && isLanguageSponsored(lang)) return;
  const gate = await checkItemCreateAllowed(auth.uid, {
    failClosed: auth.freePlan,
    // The trial account runs at its full allowance every month by design, so
    // the self-heal's per-period record scan grows without bound and would run
    // on every create. Trust the counter here; reconcile out-of-band.
    skipSelfHeal: auth.freePlan,
    // Same reasoning: the trial account has no Stripe customer, so the
    // subscription repair is a guaranteed no-op on this path.
    skipSubscriptionRepair: auth.freePlan,
  });
  if (!gate.allowed) {
    if (auth.freePlan) {
      // buildMonthlyQuotaError emits its own wall_hit.
      throw buildMonthlyQuotaError(gate.currentUsage, gate.totalAvailable);
    }
    emitEvent("wall_hit", {
      ...actor(auth),
      wall: gate.wall ?? "plan_item_limit",
      lang,
    });
    throw new Error(gate.reason || "Item limit reached");
  }
  if (auth.freePlan) {
    await assertWithinDailyPace({
      includedItems: gate.includedItems ?? 0,
      currentPeriodTotal: gate.currentUsage ?? 0,
      periodEnd: gate.periodEnd,
    });
    // Warn while there's still budget left to protect, rather than letting the
    // cap announce itself by refusing a user's request.
    await maybeAlertBudget({
      used: gate.currentUsage ?? 0,
      included: gate.includedItems ?? 0,
      periodEnd: gate.periodEnd,
    });
  }
}

/**
 * Throw when a trial item has spent its revision budget.
 *
 * Enforced at the top of generateCode rather than in updateItem because that's
 * where the money goes: the MCP client calls generateCode first and only then
 * writes the resulting taskId back through updateItem, so gating the write
 * would bill the LLM call and refuse it afterwards.
 *
 * A not-yet-written item doc (createItem generates its template before the doc
 * exists) and a first generation (no taskId yet) both read 0 and pass.
 */
export async function assertRevisionsRemaining(auth: AuthArg, itemId?: string): Promise<void> {
  if (!auth.freePlan || !itemId) return;
  const limit = trialItemRevisionLimit();
  const snap = await db().doc(`users/${auth.uid}/items/${itemId}`).get();
  if (!snap.exists) return;
  const used = Number(snap.data()?.trialRevisions) || 0;
  if (used >= limit) {
    throw buildRevisionLimitError(limit);
  }
}
