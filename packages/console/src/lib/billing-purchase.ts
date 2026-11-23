/**
 * Purchases for a customer with no live subscription, by either path, with at
 * most one in flight per customer:
 *
 *  - Saved card: subscribe with a card already on file, charged now, instead
 *    of collecting it again through Checkout (which attaches another copy).
 *  - Checkout: Stripe's hosted page, for customers without a usable card.
 *
 * Both run under the customer lease and record their purchase as the
 * customer's reservation (billing-customer-lock.ts) before calling Stripe.
 * Every operation first clears the way, from current Stripe state:
 *
 *  - The reserved purchase is recovered. A saved-card attempt is found by
 *    subscription id, or, if its create may not have reached Stripe, by
 *    replaying the create with its own idempotency key, so a holder that lost
 *    its lease mid-call and the one that took over always end up with the
 *    same subscription. A reserved Checkout session is found the same way.
 *    A replay Stripe rejects as invalid means the original never created
 *    anything (Stripe saves no result for a request that fails validation),
 *    so the reservation is dropped rather than left to block.
 *  - Every open subscription-mode Checkout session for the customer is
 *    expired, reserved or not (sessions issued before reservations existed
 *    have none), so no earlier session can later complete into a second
 *    subscription.
 *  - An earlier attempt is ended only through endAttempt(), which voids its
 *    open invoice before canceling. Voiding fails once the invoice is paid, so
 *    a payment that completes at the last moment is found and kept as the
 *    customer's subscription instead of being canceled and charged again.
 *
 * Results are always read from Stripe's current objects: an idempotent replay
 * returns the original response, which can be stale
 * (https://docs.stripe.com/api/idempotent_requests). An attempt key always
 * names one purchase: a request that reuses it with different parameters is
 * refused.
 *
 * Saved-card outcomes:
 *   active          paid; done.
 *   requires_action 3D Secure: the client confirms the returned secret with
 *                   Stripe.js, then calls finalize.
 *   processing      the payment hasn't resolved yet; finalize later.
 *   declined        the payment failed; its attempt is ended before this is
 *                   returned.
 *   ended           this attempt already ended; start a new one.
 *   mismatch        this attempt key was used for a different purchase.
 */
import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import { CustomerLockBusy, LeaseLost, type CustomerLock, type LeaseHandle, type PurchaseReservation } from './billing-customer-lock';

export interface PurchaseStripe {
  paymentMethods: Pick<Stripe['paymentMethods'], 'retrieve'>;
  subscriptions: Pick<Stripe['subscriptions'], 'list' | 'create' | 'retrieve' | 'cancel'>;
  paymentIntents: Pick<Stripe['paymentIntents'], 'retrieve'>;
  invoices: Pick<Stripe['invoices'], 'retrieve' | 'voidInvoice'>;
  checkout: { sessions: Pick<Stripe['checkout']['sessions'], 'create' | 'retrieve' | 'expire' | 'list'> };
}

export const SAVED_CARD_SOURCE = 'saved-card';
const ATTEMPT_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const LIVE = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused']);
const EXPAND = ['latest_invoice.payments'];
/** Stripe keeps idempotency keys for 24 hours; replay only well inside that. */
export const REPLAY_WINDOW_MS = 23 * 60 * 60 * 1000;
/** Checkout sessions issued here expire after this (Stripe's minimum is 30 minutes). */
export const CHECKOUT_TTL_S = 31 * 60;
const WAIT_MS = 10_000;

export type SavedCardOutcome =
  | { kind: 'active'; subscription: Stripe.Subscription }
  | { kind: 'requires_action'; subscriptionId: string; clientSecret: string }
  | { kind: 'processing'; subscriptionId: string }
  | { kind: 'declined'; message: string; declineCode: string | null; canceledSubscriptionId: string | null }
  | { kind: 'ended'; subscriptionId: string }
  | { kind: 'has_subscription'; subscriptionId: string }
  | { kind: 'mismatch' }
  | { kind: 'invalid'; reason: string };

export type CheckoutOutcome =
  | { kind: 'created'; session: Stripe.Checkout.Session }
  | { kind: 'has_subscription'; subscriptionId: string }
  | { kind: 'processing'; subscriptionId: string };

export interface StartParams {
  customerId: string;
  userId: string;
  planId: string;
  interval: string;
  paymentMethodId: string;
  attemptKey: string;
  items: Stripe.SubscriptionCreateParams.Item[];
}

export function isAttemptKey(v: unknown): v is string {
  return typeof v === 'string' && ATTEMPT_KEY.test(v);
}

// What we store is what we send, so a replay sends byte-identical parameters.
const normalize = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const idOf = (v: string | { id: string } | null | undefined) => (v == null ? null : typeof v === 'string' ? v : v.id);

/** Another request with this key is still in flight at Stripe. */
const inFlight = (e: any) => e?.statusCode === 409;
/** The key was used with different parameters. */
const keyReused = (e: any) => e?.type === 'StripeIdempotencyError' && e?.statusCode !== 409;
/** Stripe refused the request itself (validation): nothing was created and no result was saved. */
const rejected = (e: any) => e?.type === 'StripeInvalidRequestError' && (e?.statusCode ?? 400) === 400;

function invoicePaymentIntentId(sub: Stripe.Subscription): string | null {
  const inv = sub.latest_invoice;
  if (!inv || typeof inv === 'string') return null;
  const ids = ((inv as Stripe.Invoice).payments?.data ?? [])
    .map((p) => idOf(p.payment?.payment_intent as any))
    .filter((id): id is string => !!id);
  return ids[ids.length - 1] ?? null;
}

async function current(stripe: PurchaseStripe, id: string) {
  return stripe.subscriptions.retrieve(id, { expand: EXPAND });
}

/**
 * End an incomplete attempt without racing its payment: void the open invoice
 * first (Stripe refuses once it is paid, and a voided invoice's payment can no
 * longer complete), then cancel the subscription. Returns 'paid' when the
 * payment completed first; the subscription is then left as it is.
 */
async function endAttempt(stripe: PurchaseStripe, subscriptionId: string): Promise<'ended' | 'paid'> {
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  if (sub.status === 'canceled' || sub.status === 'incomplete_expired') return 'ended';
  if (sub.status !== 'incomplete') return 'paid';
  const invoiceId = idOf(sub.latest_invoice as any);
  if (invoiceId) {
    let inv = await stripe.invoices.retrieve(invoiceId);
    if (inv.status === 'open') {
      try {
        inv = await stripe.invoices.voidInvoice(invoiceId);
      } catch (e) {
        inv = await stripe.invoices.retrieve(invoiceId);
        if (inv.status !== 'paid' && inv.status !== 'void') throw e;
      }
    }
    if (inv.status === 'paid') return 'paid';
  }
  try {
    await stripe.subscriptions.cancel(subscriptionId);
  } catch (e) {
    const again = await stripe.subscriptions.retrieve(subscriptionId);
    if (again.status !== 'canceled' && again.status !== 'incomplete_expired') throw e;
  }
  return 'ended';
}

/** Map a subscription's current state to an outcome, ending it when its first payment failed. */
async function outcomeOf(stripe: PurchaseStripe, sub: Stripe.Subscription): Promise<SavedCardOutcome> {
  if (sub.status === 'active' || sub.status === 'trialing') return { kind: 'active', subscription: sub };
  if (sub.status === 'canceled' || sub.status === 'incomplete_expired') return { kind: 'ended', subscriptionId: sub.id };
  if (sub.status !== 'incomplete') return { kind: 'invalid', reason: `subscription ${sub.id} is ${sub.status}` };
  const piId = invoicePaymentIntentId(sub);
  const pi = piId ? await stripe.paymentIntents.retrieve(piId) : null;
  switch (pi?.status) {
    case 'succeeded': {
      const again = await current(stripe, sub.id);
      return again.status === 'active' || again.status === 'trialing'
        ? { kind: 'active', subscription: again }
        : { kind: 'processing', subscriptionId: sub.id };
    }
    case 'requires_action':
    case 'requires_confirmation':
      return { kind: 'requires_action', subscriptionId: sub.id, clientSecret: pi.client_secret! };
    case 'processing':
    case 'requires_capture':
      return { kind: 'processing', subscriptionId: sub.id };
    default: {
      // Declined, failed authentication, or no payment to complete.
      if ((await endAttempt(stripe, sub.id)) === 'paid') return outcomeOf(stripe, await current(stripe, sub.id));
      return {
        kind: 'declined',
        message: pi?.last_payment_error?.message ?? (pi ? 'Your card was declined.' : 'The payment could not be started.'),
        declineCode: pi?.last_payment_error?.decline_code ?? pi?.last_payment_error?.code ?? null,
        canceledSubscriptionId: sub.id,
      };
    }
  }
}

async function listSubs(stripe: PurchaseStripe, customerId: string): Promise<Stripe.Subscription[]> {
  const page = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100, expand: ['data.latest_invoice.payments'] } as any);
  return page.data;
}

/** Fenced writes after a Stripe call: losing the lease then is expected, and the next holder recovers. */
async function bestEffort(write: Promise<unknown>): Promise<void> {
  try {
    await write;
  } catch (e) {
    if (!(e instanceof LeaseLost)) throw e;
  }
}

/** Expire a Checkout session if it is still open; a session that completed meanwhile is left to the subscription check. */
async function expireSession(stripe: PurchaseStripe, customerId: string, session: Stripe.Checkout.Session) {
  if (session.status !== 'open') return;
  try {
    await stripe.checkout.sessions.expire(session.id);
  } catch (e) {
    const again = await stripe.checkout.sessions.retrieve(session.id);
    if (again.status === 'open') throw new CustomerLockBusy(customerId); // couldn't expire it; try again later
  }
}

/** The parameters that make two saved-card requests the same purchase. */
function purchaseOf(params: { items?: any; default_payment_method?: any; metadata?: any }) {
  return JSON.stringify({
    items: (params.items ?? []).map((i: any) => i.price ?? i?.price?.id),
    pm: params.default_payment_method ?? null,
    plan: params.metadata?.planId ?? null,
    interval: params.metadata?.interval ?? null,
  });
}
function purchaseOfSubscription(sub: Stripe.Subscription) {
  return JSON.stringify({
    items: sub.items?.data?.map((i) => i.price?.id) ?? [],
    pm: idOf(sub.default_payment_method as any),
    plan: sub.metadata?.planId ?? null,
    interval: sub.metadata?.interval ?? null,
  });
}

type Recovered =
  | { kind: 'none' }
  | { kind: 'attempt'; attemptKey: string; params: Record<string, unknown>; outcome: SavedCardOutcome };

/** Settle the previous operation's reservation against current Stripe state. */
async function recover(stripe: PurchaseStripe, lease: LeaseHandle): Promise<Recovered> {
  const r = await lease.reservation();
  if (!r) return { kind: 'none' };
  const fresh = Date.now() - r.createdAt < REPLAY_WINDOW_MS;

  if (r.kind === 'checkout') {
    let session: Stripe.Checkout.Session | null = null;
    try {
      if (r.sessionId) session = await stripe.checkout.sessions.retrieve(r.sessionId);
      else if (fresh) session = await stripe.checkout.sessions.create(r.params as any, { idempotencyKey: r.idempotencyKey });
    } catch (e) {
      if (inFlight(e)) throw new CustomerLockBusy(lease.customerId); // its create is still in flight
      if (!rejected(e)) throw e;
      // Rejected (e.g. its expiry is now too close): the original never made a session.
    }
    if (session) await expireSession(stripe, lease.customerId, session);
    await lease.clearReservation();
    return { kind: 'none' };
  }

  let sub: Stripe.Subscription | null = null;
  try {
    if (r.subscriptionId) sub = await current(stripe, r.subscriptionId);
    else if (fresh) sub = await current(stripe, (await stripe.subscriptions.create(r.params as any, { idempotencyKey: r.idempotencyKey })).id);
  } catch (e: any) {
    if (inFlight(e)) throw new CustomerLockBusy(lease.customerId);
    if (e?.type !== 'StripeCardError' && !rejected(e)) throw e;
  }
  // Not found by id or replay (a card error, a rejected replay, or past the window): look it up by its attempt.
  sub ??= (await listSubs(stripe, lease.customerId)).find((s) => s.metadata?.attemptKey === r.attemptKey) ?? null;
  if (!sub) {
    await lease.clearReservation();
    return { kind: 'none' };
  }
  const outcome = await outcomeOf(stripe, sub);
  if (outcome.kind !== 'requires_action' && outcome.kind !== 'processing') await lease.clearReservation();
  else if (!r.subscriptionId) await lease.reserve({ ...r, subscriptionId: sub.id });
  return { kind: 'attempt', attemptKey: r.attemptKey, params: r.params, outcome };
}

/**
 * Clear the way for a new purchase. `attempt` identifies the saved-card
 * attempt making the request (null for Checkout). Returns an outcome that
 * ends the request, or null to go ahead.
 */
async function clearForPurchase(
  stripe: PurchaseStripe,
  lease: LeaseHandle,
  attempt: { key: string; purchase: string } | null,
): Promise<SavedCardOutcome | null> {
  const rec = await recover(stripe, lease);
  if (rec.kind === 'attempt') {
    const o = rec.outcome;
    if (attempt && rec.attemptKey === attempt.key) {
      return purchaseOf(rec.params as any) === attempt.purchase ? o : { kind: 'mismatch' };
    }
    if (o.kind === 'active') return { kind: 'has_subscription', subscriptionId: o.subscription.id };
    if (o.kind === 'processing') return o;
    if (o.kind === 'requires_action') {
      // A different purchase replaces an attempt still waiting for 3D Secure,
      // unless its payment completes first.
      if ((await endAttempt(stripe, o.subscriptionId)) === 'paid') return { kind: 'has_subscription', subscriptionId: o.subscriptionId };
      await lease.clearReservation();
    }
  }

  // Sessions issued without a reservation (e.g. before this release) too.
  const sessions = await stripe.checkout.sessions.list({ customer: lease.customerId, status: 'open', limit: 100 });
  for (const session of sessions.data) {
    if (session.mode === 'subscription') await expireSession(stripe, lease.customerId, session);
  }

  const subs = await listSubs(stripe, lease.customerId);
  const live = subs.find((s) => LIVE.has(s.status));
  if (live) {
    if (attempt && live.metadata?.attemptKey === attempt.key) {
      const sub = await current(stripe, live.id);
      return purchaseOfSubscription(sub) === attempt.purchase ? { kind: 'active', subscription: sub } : { kind: 'mismatch' };
    }
    return { kind: 'has_subscription', subscriptionId: live.id };
  }
  for (const s of subs.filter((s) => s.status === 'incomplete')) {
    if (attempt && s.metadata?.attemptKey === attempt.key) {
      return purchaseOfSubscription(s) === attempt.purchase ? outcomeOf(stripe, s) : { kind: 'mismatch' };
    }
    const piId = invoicePaymentIntentId(s);
    const pi = piId ? await stripe.paymentIntents.retrieve(piId) : null;
    if (pi && ['processing', 'requires_capture'].includes(pi.status)) return { kind: 'processing', subscriptionId: s.id };
    if ((await endAttempt(stripe, s.id)) === 'paid') return { kind: 'has_subscription', subscriptionId: s.id };
  }
  return null;
}

export async function startSavedCardSubscription(
  stripe: PurchaseStripe,
  lock: CustomerLock,
  p: StartParams,
): Promise<SavedCardOutcome> {
  if (!isAttemptKey(p.attemptKey)) return { kind: 'invalid', reason: 'attemptKey is missing or malformed' };

  return lock.run(p.customerId, async (lease) => {
    const pm = await stripe.paymentMethods.retrieve(p.paymentMethodId);
    if (idOf(pm.customer as any) !== p.customerId) return { kind: 'invalid', reason: 'that card is not on this account' };

    const params = normalize<Stripe.SubscriptionCreateParams>({
      customer: p.customerId,
      items: p.items,
      default_payment_method: p.paymentMethodId,
      payment_behavior: 'allow_incomplete',
      expand: EXPAND,
      metadata: { userId: p.userId, planId: p.planId, interval: p.interval, attemptKey: p.attemptKey, source: SAVED_CARD_SOURCE },
    });
    const stop = await clearForPurchase(stripe, lease, { key: p.attemptKey, purchase: purchaseOf(params) });
    if (stop) return stop;

    const reservation: PurchaseReservation = {
      kind: 'saved-card',
      attemptKey: p.attemptKey,
      idempotencyKey: `saved-card-subscribe:${p.customerId}:${p.attemptKey}`,
      params: params as any,
      createdAt: Date.now(),
    };
    await lease.reserve(reservation); // fenced: a holder that lost its lease stops here
    await lease.renew();

    let created: Stripe.Subscription;
    try {
      created = await stripe.subscriptions.create(params, { idempotencyKey: reservation.idempotencyKey });
    } catch (e: any) {
      if (inFlight(e)) throw new CustomerLockBusy(p.customerId);
      if (keyReused(e)) {
        await bestEffort(lease.clearReservation());
        return { kind: 'mismatch' };
      }
      if (e?.type !== 'StripeCardError') throw e;
      // A card error can still leave this attempt's subscription behind.
      const left = (await listSubs(stripe, p.customerId))
        .find((s) => s.status === 'incomplete' && s.metadata?.attemptKey === p.attemptKey);
      if (left && (await endAttempt(stripe, left.id)) === 'paid') {
        await bestEffort(lease.clearReservation());
        return outcomeOf(stripe, await current(stripe, left.id));
      }
      await bestEffort(lease.clearReservation());
      return { kind: 'declined', message: e.message ?? 'Your card was declined.', declineCode: e.decline_code ?? e.code ?? null, canceledSubscriptionId: left?.id ?? null };
    }

    // Never trust the create response: a replayed key returns the original.
    const sub = await current(stripe, created.id);
    await bestEffort(lease.reserve({ ...reservation, subscriptionId: sub.id }));
    const outcome = await outcomeOf(stripe, sub);
    if (outcome.kind !== 'requires_action' && outcome.kind !== 'processing') await bestEffort(lease.clearReservation());
    return outcome;
  }, { waitMs: WAIT_MS });
}

/** After 3D Secure (or while processing): read the subscription and report where it stands. */
export async function finalizeSavedCardSubscription(
  stripe: PurchaseStripe,
  lock: CustomerLock,
  p: { customerId: string; subscriptionId: string },
): Promise<SavedCardOutcome> {
  return lock.run(p.customerId, async (lease) => {
    const sub = await current(stripe, p.subscriptionId);
    if (idOf(sub.customer as any) !== p.customerId || sub.metadata?.source !== SAVED_CARD_SOURCE) {
      return { kind: 'invalid', reason: 'unknown subscription' };
    }
    const outcome = await outcomeOf(stripe, sub);
    const r = await lease.reservation();
    if (r?.kind === 'saved-card' && (r.subscriptionId === sub.id || r.attemptKey === sub.metadata?.attemptKey)
        && outcome.kind !== 'requires_action' && outcome.kind !== 'processing') {
      await lease.clearReservation();
    }
    return outcome;
  }, { waitMs: WAIT_MS });
}

/**
 * Create a Checkout session as the customer's reserved purchase, after the
 * way is cleared (above). The session expires after CHECKOUT_TTL_S, bounding
 * how long it can complete.
 */
export async function createReservedCheckoutSession(
  stripe: PurchaseStripe,
  lock: CustomerLock,
  customerId: string,
  build: () => Stripe.Checkout.SessionCreateParams,
): Promise<CheckoutOutcome> {
  return lock.run(customerId, async (lease) => {
    const stop = await clearForPurchase(stripe, lease, null);
    if (stop?.kind === 'has_subscription' || stop?.kind === 'processing') return stop;
    if (stop) throw new Error(`unexpected purchase state ${stop.kind}`);

    const params = normalize<Stripe.Checkout.SessionCreateParams>({
      ...build(),
      expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_TTL_S,
    });
    const reservation: PurchaseReservation = {
      kind: 'checkout',
      idempotencyKey: `checkout-session:${customerId}:${randomUUID()}`,
      params: params as any,
      createdAt: Date.now(),
    };
    await lease.reserve(reservation);
    await lease.renew();
    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.create(params, { idempotencyKey: reservation.idempotencyKey });
    } catch (e) {
      if (inFlight(e)) throw new CustomerLockBusy(customerId);
      if (rejected(e)) await bestEffort(lease.clearReservation()); // nothing was created
      throw e;
    }
    try {
      await lease.reserve({ ...reservation, sessionId: session.id });
    } catch (e) {
      if (!(e instanceof LeaseLost)) throw e;
      // Taken over mid-create: the new holder recovered this session (and expired
      // it if it was still open). Report what it is now.
      session = await stripe.checkout.sessions.retrieve(session.id);
      if (session.status !== 'open') throw new CustomerLockBusy(customerId);
    }
    return { kind: 'created', session };
  }, { waitMs: WAIT_MS });
}
