import { NextApiRequest, NextApiResponse } from 'next';
import { getFirestore } from '../../../utils/db';
import { getPlan, overageDollarsToItems, defaultOverageCapUsd, payAsYouGoEnabled, DEFAULT_PLAN } from '../../../lib/plans-config';
import { emitEvent, actor } from '../../../lib/funnel-events';
import { requireUser } from '../../../lib/api-auth';

// Set (or clear) a customer's overage spend cap. The client sends a dollar
// budget; we store it as a number of items using the plan's per-item rate. A
// null/absent limit means unlimited overage (billed in arrears via the meter) —
// except on Bronze, where it resets to the plan's default cap.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const auth = await requireUser(req);
    if (!auth) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const userId = auth.uid;
    const { limitUsd } = req.body ?? {};

    const db = getFirestore();
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const subscription = userDoc.data()?.subscription;
    const plan = subscription?.plan || DEFAULT_PLAN;
    const planConfig = getPlan(plan);
    // A cap on a hard-capped tier only means something once the account can
    // actually incur overage — which requires a card. Setting a cap is the
    // second of the two moments we ask for payment details (the first is the
    // wall itself); tell the client to route into Checkout rather than storing
    // a number that would never be enforced.
    const needsEnrollment = planConfig.overageRatePerItem != null &&
      planConfig.hardCap &&
      !payAsYouGoEnabled(subscription);
    if (needsEnrollment) {
      return res.status(402).json({
        error: 'Payment method required',
        message: `${planConfig.displayName} includes ${planConfig.includedItems} items per month. ` +
          `Add a payment method to create more at $${planConfig.overageRatePerItem!.toFixed(2)} per item.`,
        requiresPaymentMethod: true,
        plan,
        overageRatePerItem: planConfig.overageRatePerItem,
        includedItems: planConfig.includedItems,
      });
    }

    // null means "no cap" (unlimited), so it is the HIGHEST value, not the
    // lowest — the comparisons below have to treat it that way.
    const prevUsd = subscription?.overageLimitUsd ?? null;

    // Clearing the cap. A card behind a $0-base plan is never uncapped, so on
    // Bronze "remove" goes back to the plan default instead.
    if (limitUsd === null || limitUsd === undefined || limitUsd === '') {
      const resetUsd = planConfig.hardCap ? defaultOverageCapUsd(plan) : null;
      const resetItems = resetUsd != null ? overageDollarsToItems(plan, resetUsd) : null;
      if (resetUsd != null && resetItems != null) {
        await db.collection('users').doc(userId).update({
          'subscription.overageLimitItems': resetItems,
          'subscription.overageLimitUsd': resetUsd,
        });
        if (prevUsd !== null && resetUsd > prevUsd) {
          emitEvent('overage_limit_raised', { ...actor({ uid: userId }), plan, from: String(prevUsd), to: String(resetUsd) });
        }
        return res.status(200).json({ overageLimitItems: resetItems, overageLimitUsd: resetUsd });
      }
      await db.collection('users').doc(userId).update({
        'subscription.overageLimitItems': null,
        'subscription.overageLimitUsd': null,
      });
      if (prevUsd !== null) {
        emitEvent('overage_limit_raised', { ...actor({ uid: userId }), plan, from: String(prevUsd), to: 'unlimited' });
      }
      return res.status(200).json({ overageLimitItems: null, overageLimitUsd: null });
    }

    const usd = Number(limitUsd);
    if (!Number.isFinite(usd) || usd < 0) {
      return res.status(400).json({ error: 'limitUsd must be a non-negative number or null' });
    }

    // Contact-sales tiers have no overage path.
    if (planConfig.overageRatePerItem == null) {
      return res.status(400).json({ error: `Plan "${plan}" does not support overage` });
    }

    const overageLimitItems = overageDollarsToItems(plan, usd) ?? 0;
    await db.collection('users').doc(userId).update({
      'subscription.overageLimitItems': overageLimitItems,
      'subscription.overageLimitUsd': usd,
    });

    // Only an increase is the expansion signal. Coming down from unlimited
    // (prevUsd === null) is a tightening, however large the new number.
    if (prevUsd !== null && usd > prevUsd) {
      emitEvent('overage_limit_raised', { ...actor({ uid: userId }), plan, from: String(prevUsd), to: String(usd) });
    }

    return res.status(200).json({ overageLimitItems, overageLimitUsd: usd });
  } catch (error) {
    console.error('Error setting overage limit:', error);
    return res.status(500).json({
      error: 'Failed to set overage limit',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
