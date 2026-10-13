import { NextApiRequest, NextApiResponse } from 'next';
import { getFirestore } from '../../../utils/db';
import { languageSponsor } from '../../../lib/languages';
import Stripe from 'stripe';
import { STRIPE_API_VERSION, priceIdToPlan, effectiveIncludedItems, overageRateFor, isHardCappedFor, payAsYouGoEnabled, DEFAULT_PLAN, type PlanId } from '../../../lib/plans-config';
import { subscriptionPeriodStart, subscriptionPeriodEnd } from '../../../lib/stripe-helpers';
import { requireUser } from '../../../lib/api-auth';

// Initialize Stripe only if secret key is available
let stripe: Stripe | null = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: STRIPE_API_VERSION,
  });
}

interface DailyUsage {
  date: string;
  count: number;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const auth = await requireUser(req);
    if (!auth) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const userId = auth.uid;


    const db = getFirestore();
    const now = new Date();

    // Get user's subscription to determine billing period
    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data();
    const stripeCustomerId = userData?.stripeCustomerId;

    let firstDayOfPeriod: Date;
    let lastDayOfPeriod: Date;
    let billingInterval: 'monthly' | 'annual' | null = null;
    let currentPlan: PlanId | null = null;

    // Try to get billing period and plan from Stripe subscription
    if (stripeCustomerId && stripe) {
      try {
        const subscriptions = await stripe.subscriptions.list({
          customer: stripeCustomerId,
          status: 'active',
          limit: 1,
        });

        // Also check for trialing subscriptions
        if (subscriptions.data.length === 0) {
          const trialingSubscriptions = await stripe.subscriptions.list({
            customer: stripeCustomerId,
            status: 'trialing',
            limit: 1,
          });
          subscriptions.data.push(...trialingSubscriptions.data);
        }

        if (subscriptions.data.length > 0) {
          const subscription = subscriptions.data[0];

          // Get billing interval and plan (match the base price to a plan)
          const priceInterval = subscription.items.data[0]?.price.recurring?.interval;
          billingInterval = priceInterval === 'year' ? 'annual' : priceInterval === 'month' ? 'monthly' : null;
          currentPlan = subscription.items.data
            .map(it => priceIdToPlan(it?.price?.id))
            .find(Boolean) || DEFAULT_PLAN;

          // For annual plans, calculate monthly reset periods
          // For monthly plans, use Stripe's billing period
          if (billingInterval === 'annual') {
            // Use subscription start as anchor, calculate current month within annual period
            const subscriptionStart = new Date((subscriptionPeriodStart(subscription) as number) * 1000);
            const anchorDay = subscriptionStart.getDate();

            const currentMonth = now.getMonth();
            const currentYear = now.getFullYear();

            let periodStart = new Date(currentYear, currentMonth, anchorDay);
            if (periodStart > now) {
              periodStart = new Date(currentYear, currentMonth - 1, anchorDay);
            }

            let periodEnd = new Date(periodStart);
            periodEnd.setMonth(periodEnd.getMonth() + 1);

            firstDayOfPeriod = periodStart;
            lastDayOfPeriod = periodEnd;
          } else {
            // Monthly plan: use Stripe billing period directly
            firstDayOfPeriod = new Date((subscriptionPeriodStart(subscription) as number) * 1000);
            lastDayOfPeriod = new Date((subscriptionPeriodEnd(subscription) as number) * 1000);
          }
        } else {
          const currentMonth = now.getMonth();
          const currentYear = now.getFullYear();
          firstDayOfPeriod = new Date(currentYear, currentMonth, 1);
          lastDayOfPeriod = new Date(currentYear, currentMonth + 1, 0);
        }
      } catch (error) {
        console.error('Error fetching Stripe subscription for billing period:', error);
        const currentMonth = now.getMonth();
        const currentYear = now.getFullYear();
        firstDayOfPeriod = new Date(currentYear, currentMonth, 1);
        lastDayOfPeriod = new Date(currentYear, currentMonth + 1, 0);
      }
    } else {
      // No Stripe customer - Free users use calendar month (or preserved dates on downgrade)
      const preservedRenewalDate = userData?.subscription?.renewalDate;
      const preservedUntil = userData?.subscription?.preservedUntil;

      if (preservedRenewalDate || preservedUntil) {
        const renewalDate = preservedUntil || preservedRenewalDate;
        lastDayOfPeriod = new Date(renewalDate);
        firstDayOfPeriod = new Date(lastDayOfPeriod);
        firstDayOfPeriod.setMonth(firstDayOfPeriod.getMonth() - 1);
      } else {
        const currentMonth = now.getMonth();
        const currentYear = now.getFullYear();
        firstDayOfPeriod = new Date(currentYear, currentMonth, 1);
        lastDayOfPeriod = new Date(currentYear, currentMonth + 1, 0, 23, 59, 59);
      }
    }

    // Fall back to the stored plan for Free/no-Stripe accounts.
    const plan: PlanId = currentPlan || (userData?.subscription?.plan as PlanId) || DEFAULT_PLAN;

    // Items created this period. The counter is the item count; self-heal it
    // against the actual records (billable items carry units: 1).
    const usageRef = db.collection('usage').doc(userId);
    const usageDoc = await usageRef.get();

    let itemsUsed = 0;
    let sponsoredItems = 0;
    let sponsors: string[] = [];
    let sponsoredByLanguage: { lang: string; sponsor: string | null; items: number }[] = [];
    let dailyUsage: DailyUsage[] = [];
    let lastUpdate: string | null = null;

    if (usageDoc.exists) {
      const data = usageDoc.data();
      const lastReset = data?.lastReset ? new Date(data.lastReset) : null;
      const needsReset = lastReset && lastReset < firstDayOfPeriod;
      itemsUsed = needsReset ? 0 : (data?.currentMonthTotal || 0);
      lastUpdate = data?.lastUpdate || null;
    }

    // One range query serves both numbers, and it runs whether or not the rollup
    // doc exists: sponsored items never touch currentMonthTotal, so an account
    // whose only usage is sponsored has no rollup doc at all and would otherwise
    // report nothing.
    try {
      const usageRecordsSnapshot = await db
        .collection('usage')
        .where('userId', '==', userId)
        .where('createdAt', '>=', firstDayOfPeriod)
        .where('createdAt', '<=', lastDayOfPeriod)
        .get();

      // Count only billable item records (pre-migration compile/ai_generation
      // records carry compile-unit `units` and are not items).
      let calculatedTotal = 0;
      const sponsorNames = new Set<string>();
      const langCounts = new Map<string, { sponsor: string | null; items: number }>();
      usageRecordsSnapshot.docs.forEach(doc => {
        const r = doc.data();
        if (r.type !== 'item_created') return;
        calculatedTotal += r.units || 0;
        // Disjoint from the sum above by construction: a sponsored row is
        // units: 0. Local-script rows are neither — they are our runs, not the
        // customer's usage, and must never surface here.
        if (r.nonBillableReason === 'sponsored') {
          sponsoredItems += 1;
          if (r.lang) {
            const lang = `L${String(r.lang).replace(/^L/i, '')}`;
            // Resolved from config at read time rather than stored on the row:
            // a sponsor renaming itself should not need a data migration.
            const by = languageSponsor(r.lang);
            if (by) sponsorNames.add(by);
            const entry = langCounts.get(lang) ?? { sponsor: by ?? null, items: 0 };
            entry.items += 1;
            langCounts.set(lang, entry);
          }
        }
      });
      itemsUsed = calculatedTotal;
      sponsors = Array.from(sponsorNames).sort();
      sponsoredByLanguage = Array.from(langCounts, ([lang, v]) => ({ lang, ...v }))
        .sort((a, b) => b.items - a.items || a.lang.localeCompare(b.lang));
    } catch (breakdownError) {
      console.error('Error fetching usage breakdown (may need Firestore index):', breakdownError);
    }

    if (usageDoc.exists) {
      // Optional daily breakdown (best-effort)
      try {
        const dailyRef = await db
          .collection('usage')
          .doc(userId)
          .collection('daily')
          .where('timestamp', '>=', firstDayOfPeriod)
          .where('timestamp', '<=', lastDayOfPeriod)
          .orderBy('timestamp', 'asc')
          .get();

        dailyUsage = dailyRef.docs.map(doc => {
          const d = doc.data();
          return { date: d.timestamp.toDate().toISOString().split('T')[0], count: d.count || 0 };
        });
      } catch (dailyError) {
        dailyUsage = [];
      }
    }

    // Included items (a downgrade's preserved allocation raises this during
    // grace; it never caps the plan below its own included items).
    const includedItems = effectiveIncludedItems(plan, userData?.subscription, now);

    const overageRatePerItem = overageRateFor(plan);
    // Enrollment-aware: a Bronze account with a card on file is no longer
    // capped at its included items, it is capped by its own spend cap.
    const hardCap = isHardCappedFor(plan, userData?.subscription);
    const paygEnabled = payAsYouGoEnabled(userData?.subscription);
    // The tier offers pay-as-you-go and this account hasn't taken it — i.e.
    // adding a card is the way past the wall, not upgrading.
    const paygAvailable = hardCap && overageRatePerItem != null;

    // Customer overage spend cap (items). null = unlimited (paid, billed in arrears).
    const overageLimitItems = typeof userData?.subscription?.overageLimitItems === 'number'
      ? userData.subscription.overageLimitItems
      : null;
    const overageLimitUsd = typeof userData?.subscription?.overageLimitUsd === 'number'
      ? userData.subscription.overageLimitUsd
      : null;

    const overageItems = Math.max(0, itemsUsed - includedItems);
    const overageCostUsd = overageRatePerItem ? overageItems * overageRatePerItem : 0;

    // The hard ceiling on creation: included for Free; included + cap for paid
    // with a cap; null (unlimited) for paid without a cap.
    const creationLimit = hardCap
      ? includedItems
      : (overageLimitItems === null ? null : includedItems + overageLimitItems);
    const remaining = creationLimit === null ? null : Math.max(0, creationLimit - itemsUsed);
    const percentageUsed = creationLimit && creationLimit > 0
      ? Math.min(100, (itemsUsed / creationLimit) * 100)
      : 0;

    return res.status(200).json({
      plan,
      itemsUsed,
      sponsoredItems,
      sponsors,
      sponsoredByLanguage,
      includedItems,
      overageItems,
      overageRatePerItem,
      overageCostUsd,
      hardCap,
      payAsYouGoEnabled: paygEnabled,
      payAsYouGoAvailable: paygAvailable,
      overageLimitItems,
      overageLimitUsd,
      lastResetDate: firstDayOfPeriod.toISOString(),
      currentPeriodEnd: lastDayOfPeriod.toISOString(),
      extended: {
        currentPeriod: {
          start: firstDayOfPeriod.toISOString(),
          end: lastDayOfPeriod.toISOString(),
        },
        usage: {
          total: itemsUsed,
          limit: creationLimit,
          remaining,
          percentage: Math.round(percentageUsed * 10) / 10,
        },
        dailyUsage,
        lastUpdate,
      },
    });
  } catch (error) {
    console.error('Error fetching usage:', error);
    return res.status(500).json({
      error: 'Failed to fetch usage data',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}
