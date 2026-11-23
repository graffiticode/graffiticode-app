/**
 * Duplicate-card reconciliation: collapse PaymentMethods that are the same
 * physical card, reading only current Stripe state.
 *
 * Why state, not events: Stripe doesn't guarantee event order
 * (https://docs.stripe.com/webhooks#event-ordering). A Checkout payment
 * attaches its card (payment_method.attached) before the subscription that
 * uses it exists, so deciding from the attach event alone can detach the card a
 * subscription is about to bill. Instead every relevant event asks the same
 * question of current state, and the answer is the same whichever event asks
 * last: nothing happens while a payment flow is still in progress, and once
 * it has settled the cleanup is computed from what references each card.
 *
 * Rules:
 *  - Two methods are the same card only when both are type `card` and carry
 *    the same non-empty fingerprint. A missing or different fingerprint leaves
 *    both alone.
 *  - A method referenced by a live subscription, a subscription schedule, an
 *    unpaid invoice, or a payment or setup intent that hasn't finished is never
 *    detached and never re-pointed. The only reference this changes is the
 *    customer's invoice default, and only to another copy of the same card.
 *  - While any flow is unsettled (an open Checkout session, an incomplete
 *    subscription, an intent awaiting action or processing) nothing is
 *    changed; a later event, or the sweep script, reconciles.
 *  - Before each detach the state is read again, and the detach is skipped if
 *    anything changed.
 */
import type Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { LeaseLost, type CustomerLock, type LeaseHandle, type PendingWrite } from './billing-customer-lock';

export type ReconcileMode = 'off' | 'dry-run' | 'apply';

/** The Stripe calls reconciliation makes (all reads, plus the two writes). */
export interface ReconcileStripe {
  customers: Pick<Stripe['customers'], 'retrieve' | 'update'>;
  paymentMethods: Pick<Stripe['paymentMethods'], 'list' | 'retrieve' | 'detach'>;
  subscriptions: Pick<Stripe['subscriptions'], 'list' | 'update' | 'retrieve'>;
  subscriptionSchedules: Pick<Stripe['subscriptionSchedules'], 'list'>;
  invoices: Pick<Stripe['invoices'], 'list'>;
  paymentIntents: Pick<Stripe['paymentIntents'], 'list'>;
  setupIntents: Pick<Stripe['setupIntents'], 'list'>;
  checkout: { sessions: Pick<Stripe['checkout']['sessions'], 'list' | 'retrieve'> };
  events: Pick<Stripe['events'], 'list'>;
}

export function reconcileModeFromEnv(value: string | undefined): ReconcileMode {
  // Dry run unless explicitly turned on: detaching is irreversible.
  return value === 'apply' || value === 'off' ? value : 'dry-run';
}

const idOf = (v: string | { id: string } | null | undefined): string | null =>
  v == null ? null : typeof v === 'string' ? v : v.id;

/** Same physical card: both `card`, both fingerprinted, fingerprints equal. */
export function sameCard(a: Stripe.PaymentMethod, b: Stripe.PaymentMethod): boolean {
  const fa = a.type === 'card' ? a.card?.fingerprint : null;
  const fb = b.type === 'card' ? b.card?.fingerprint : null;
  return !!fa && !!fb && fa === fb;
}

const SUB_ENDED = new Set(['canceled', 'incomplete_expired']);
const INVOICE_UNPAID = new Set(['draft', 'open', 'uncollectible']);
const PI_DONE = new Set(['succeeded', 'canceled']);
const PI_IN_FLIGHT = new Set(['requires_action', 'requires_confirmation', 'requires_capture', 'processing']);
const SI_DONE = new Set(['succeeded', 'canceled']);
const SI_IN_FLIGHT = new Set(['requires_action', 'requires_confirmation', 'processing']);
const SCHEDULE_ENDED = new Set(['canceled', 'completed', 'released']);

export interface CustomerPaymentState {
  customerId: string;
  customerDefault: string | null;
  methods: Stripe.PaymentMethod[];
  /** Payment method id → what references it (other than the customer default). */
  references: Map<string, string[]>;
  /** Why the customer's payment state isn't settled; empty when it is. */
  unsettled: string[];
}

async function listAll<T extends { id: string }>(
  list: (params: any) => Promise<Stripe.ApiList<T>>,
  params: Record<string, unknown>,
): Promise<T[]> {
  const out: T[] = [];
  let starting_after: string | undefined;
  for (;;) {
    const page = await list({ ...params, limit: 100, ...(starting_after ? { starting_after } : {}) });
    out.push(...page.data);
    if (!page.has_more || page.data.length === 0) return out;
    starting_after = page.data[page.data.length - 1].id;
  }
}

/** Read everything that can reference or be about to reference a customer's cards. */
export async function readCustomerPaymentState(stripe: ReconcileStripe, customerId: string): Promise<CustomerPaymentState> {
  const [customer, methods, subs, schedules, invoices, intents, setups, sessions] = await Promise.all([
    stripe.customers.retrieve(customerId) as Promise<Stripe.Customer | Stripe.DeletedCustomer>,
    listAll<Stripe.PaymentMethod>((p) => stripe.paymentMethods.list(p), { customer: customerId }),
    listAll<Stripe.Subscription>((p) => stripe.subscriptions.list(p), { customer: customerId, status: 'all' }),
    listAll<Stripe.SubscriptionSchedule>((p) => stripe.subscriptionSchedules.list(p), { customer: customerId }),
    listAll<Stripe.Invoice & { id: string }>((p) => stripe.invoices.list(p) as any, { customer: customerId }),
    listAll<Stripe.PaymentIntent>((p) => stripe.paymentIntents.list(p), { customer: customerId }),
    listAll<Stripe.SetupIntent>((p) => stripe.setupIntents.list(p), { customer: customerId }),
    listAll<Stripe.Checkout.Session>((p) => stripe.checkout.sessions.list(p), { customer: customerId, status: 'open' }),
  ]);

  const references = new Map<string, string[]>();
  const ref = (pm: string | { id: string } | null | undefined, why: string) => {
    const id = idOf(pm);
    if (!id) return;
    references.set(id, [...(references.get(id) ?? []), why]);
  };
  const unsettled: string[] = [];

  for (const s of subs) {
    if (SUB_ENDED.has(s.status)) continue;
    ref(s.default_payment_method as any, `subscription ${s.id}`);
    if (s.status === 'incomplete') unsettled.push(`subscription ${s.id} is incomplete`);
  }
  for (const sch of schedules) {
    if (SCHEDULE_ENDED.has(sch.status)) continue;
    ref(sch.default_settings?.default_payment_method as any, `schedule ${sch.id}`);
    for (const phase of sch.phases ?? []) ref(phase.default_payment_method as any, `schedule ${sch.id}`);
  }
  for (const inv of invoices) {
    if (!INVOICE_UNPAID.has(inv.status ?? '')) continue;
    ref(inv.default_payment_method as any, `invoice ${inv.id}`);
  }
  for (const pi of intents) {
    if (PI_DONE.has(pi.status)) continue;
    ref(pi.payment_method as any, `payment intent ${pi.id}`);
    if (PI_IN_FLIGHT.has(pi.status)) unsettled.push(`payment intent ${pi.id} is ${pi.status}`);
  }
  for (const si of setups) {
    if (SI_DONE.has(si.status)) continue;
    ref(si.payment_method as any, `setup intent ${si.id}`);
    if (SI_IN_FLIGHT.has(si.status)) unsettled.push(`setup intent ${si.id} is ${si.status}`);
  }
  for (const cs of sessions) unsettled.push(`checkout session ${cs.id} is open`);

  const deleted = (customer as Stripe.DeletedCustomer).deleted === true;
  return {
    customerId,
    customerDefault: deleted ? null : idOf((customer as Stripe.Customer).invoice_settings?.default_payment_method as any),
    methods,
    references,
    unsettled,
  };
}

export interface ReconcilePlan {
  deferred: string[];
  /** Re-point the customer's invoice default to this method first (a copy of the same card). */
  setDefault: string | null;
  /** The default that re-pointing replaces; it is applied only if the default is still this. */
  fromDefault: string | null;
  detach: Array<{ id: string; duplicateOf: string }>;
  kept: string[];
}

const newestFirst = (a: Stripe.PaymentMethod, b: Stripe.PaymentMethod) =>
  b.created - a.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Decide, from one snapshot of state, what to change. Pure. */
export function planReconciliation(state: CustomerPaymentState): ReconcilePlan {
  const plan: ReconcilePlan = { deferred: [...state.unsettled], setDefault: null, fromDefault: state.customerDefault, detach: [], kept: [] };
  if (plan.deferred.length > 0) return plan;

  // Group only fingerprinted cards; everything else is left alone.
  const groups = new Map<string, Stripe.PaymentMethod[]>();
  for (const pm of state.methods) {
    const fp = pm.type === 'card' ? pm.card?.fingerprint : null;
    if (!fp) continue;
    groups.set(fp, [...(groups.get(fp) ?? []), pm]);
  }

  let customerDefault = state.customerDefault;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const referenced = group.filter((pm) => (state.references.get(pm.id) ?? []).length > 0).sort(newestFirst);
    const defaultInGroup = group.find((pm) => pm.id === customerDefault) ?? null;

    let keeper: Stripe.PaymentMethod;
    if (referenced.length === 0) {
      keeper = defaultInGroup ?? [...group].sort(newestFirst)[0];
    } else if (defaultInGroup && referenced.some((pm) => pm.id === defaultInGroup.id)) {
      keeper = defaultInGroup;
    } else {
      // The copy something actually bills is the one to keep. When the
      // customer default is an unreferenced copy of it, point the default at
      // the keeper so the old copy is free to go.
      keeper = referenced[0];
      if (defaultInGroup) {
        plan.setDefault = keeper.id;
        customerDefault = keeper.id;
      }
    }

    const keep = new Set([keeper.id, ...referenced.map((pm) => pm.id)]);
    for (const pm of group) {
      if (keep.has(pm.id)) plan.kept.push(pm.id);
      else plan.detach.push({ id: pm.id, duplicateOf: keeper.id });
    }
  }
  return plan;
}

export interface ReconcileResult {
  mode: ReconcileMode;
  plan: ReconcilePlan;
  defaultSet: string | null;
  detached: string[];
  /** Detaches skipped because state changed after planning. */
  skipped: Array<{ id: string; reason: string }>;
  /** A console default choice re-applied after a write that may have landed over it. */
  repairedChoice: string | null;
  /** Reconciliation writes not yet known to be settled (dry-run reports them without settling). */
  pendingWrites: PendingWrite[];
}

/**
 * A purchase reservation (billing-purchase.ts) names a card its purchase will
 * bill, possibly before Stripe shows any subscription or intent for it. It
 * blocks cleanup until Stripe shows the purchase finished; a finished one's
 * leftover record is cleared here (apply mode). Returns why cleanup must wait,
 * or null.
 */
async function unresolvedReservation(stripe: ReconcileStripe, lease: LeaseHandle, clearFinished: boolean): Promise<string | null> {
  const r = await lease.reservation();
  if (!r) return null;
  if (r.kind === 'checkout' && r.sessionId) {
    const session = await stripe.checkout.sessions.retrieve(r.sessionId);
    if (session.status === 'open') return `checkout session ${r.sessionId} is open`;
  } else if (r.kind === 'saved-card' && r.subscriptionId) {
    const sub = await stripe.subscriptions.retrieve(r.subscriptionId);
    if (!['active', 'trialing', 'canceled', 'incomplete_expired'].includes(sub.status)) {
      return `purchase subscription ${r.subscriptionId} is ${sub.status}`;
    }
  } else {
    // Its create may not have reached Stripe yet.
    return `a ${r.kind} purchase is reserved and not yet visible in Stripe`;
  }
  if (clearFinished) await lease.clearReservation();
  return null;
}

/**
 * Each reconciliation write is sent at most once, inside a short window: the
 * writer checks `sendBy` immediately before the call and gives its client a
 * timeout inside the window with no network retries, so the request is never
 * re-sent later by the SDK.
 */
export const SEND_WINDOW_MS = 2 * 60 * 1000;
/** Stripe keeps events for 30 days; a claimed write is watched for a late landing this long. */
export const WATCH_MS = 29 * 24 * 60 * 60 * 1000;
const LANDING_EVENTS = ['customer.updated', 'payment_method.detached', 'customer.subscription.updated'];

export type ClaimOutcome = 'never-applied' | 'applied' | 'in-flight';

/**
 * Probe a pending write through Stripe's idempotency: send a no-op request
 * (an empty customer update) under the write's own key.
 *  - It succeeds: the key was unused, so the original had not reached Stripe;
 *    while Stripe retains this claim, the original is refused if it arrives.
 *  - Stripe refuses it as a reused key: the original was applied.
 *  - 409: the original is still in flight; nothing is known yet.
 * https://docs.stripe.com/api/idempotent_requests
 *
 * A claim is not a permanent fence: once Stripe prunes the key, a stalled
 * original could apply. So a claimed write stays recorded and watched
 * (landedKeys) rather than forgotten.
 */
export async function claimWrite(stripe: ReconcileStripe, customerId: string, w: PendingWrite): Promise<ClaimOutcome> {
  try {
    await stripe.customers.update(customerId, {}, { idempotencyKey: w.idempotencyKey });
    return 'never-applied';
  } catch (e: any) {
    if (e?.statusCode === 409) return 'in-flight';
    if (e?.type === 'StripeIdempotencyError') return 'applied';
    throw e;
  }
}

/**
 * Which of these writes Stripe has applied, read from its events: every event
 * records the idempotency key of the request that caused it, so this works
 * whether or not Stripe still retains the key.
 */
export async function landedKeys(stripe: ReconcileStripe, writes: PendingWrite[]): Promise<Set<string>> {
  const keys = new Set(writes.map((w) => w.idempotencyKey));
  const landed = new Set<string>();
  if (keys.size === 0) return landed;
  const since = Math.floor(Math.min(...writes.map((w) => w.at)) / 1000) - 60;
  let starting_after: string | undefined;
  for (;;) {
    const page = await stripe.events.list({ created: { gte: since }, types: LANDING_EVENTS, limit: 100, ...(starting_after ? { starting_after } : {}) });
    for (const e of page.data) {
      const k = e.request?.idempotency_key;
      if (k && keys.has(k)) landed.add(k);
    }
    if (!page.has_more || page.data.length === 0 || landed.size === keys.size) return landed;
    starting_after = page.data[page.data.length - 1].id;
  }
}

interface Settlement {
  /** Writes that may still land unseen: cleanup waits for them. */
  inFlight: PendingWrite[];
  /** Every pending write left after settling: in flight, and claimed ones still watched. */
  remaining: PendingWrite[];
  /** The console choice re-applied over writes that landed, if any. */
  repaired: string | null;
}

/**
 * Settle pending writes (apply mode only).
 *  - A write that landed (its key refused, or seen in Stripe's events) is
 *    repaired over (the latest console choice re-applied) and forgotten.
 *  - A write never seen by Stripe is claimed, then kept and watched: it can't
 *    apply while Stripe retains the claim, and if it applies after that it
 *    shows up in the events and is repaired then. It is forgotten after
 *    WATCH_MS, once its writer is long past its send window.
 *  - A write still in flight is kept, and cleanup waits.
 *  - A write never claimed and older than Stripe's key retention can't be
 *    shown unapplied by a claim (its key may be gone): the events, read
 *    first, decide, and it is then claimed and watched like any other.
 */
async function settlePendingWrites(stripe: ReconcileStripe, lease: LeaseHandle, customerId: string): Promise<Settlement> {
  const pending = await lease.pendingWrites();
  if (pending.length === 0) return { inFlight: [], remaining: [], repaired: null };
  const now = Date.now();
  const landedByEvent = await landedKeys(stripe, pending);
  const landed: PendingWrite[] = [];
  const inFlight: PendingWrite[] = [];
  const expired: PendingWrite[] = [];
  for (const w of pending) {
    if (landedByEvent.has(w.idempotencyKey)) {
      landed.push(w);
      continue;
    }
    if (w.claimedAt) {
      if (now - w.at > WATCH_MS) expired.push(w);
      continue; // still watched
    }
    await lease.renew();
    const outcome = await claimWrite(stripe, customerId, w);
    if (outcome === 'in-flight') inFlight.push(w);
    // A refusal is reliable at any age: Stripe still holds the key, so the original used it.
    else if (outcome === 'applied') landed.push(w);
    // "Never applied" is reliable only while Stripe would still hold the key; for an older
    // write the events above are the authority (they found no landing). Either way: watch it.
    else await lease.addPendingWrite({ ...w, claimedAt: now });
  }
  const since = landed.length ? Math.min(...landed.map((w) => w.sinceSeq)) : Infinity;
  const repaired = landed.length ? await restoreUnder(stripe, lease, customerId, since) : null;
  await lease.removePendingWrites([...landed, ...expired].map((w) => w.id));
  return { inFlight, remaining: await lease.pendingWrites(), repaired };
}

/** The writer's own deadline passed before it could send: nothing was sent. */
export class SendWindowClosed extends Error {
  constructor() {
    super('reconciliation write not sent: its send window closed');
    this.name = 'SendWindowClosed';
  }
}

/**
 * Send one reconciliation write as a pending write: recorded before it is
 * sent, under its own idempotency key, sent only inside its window, and
 * forgotten only if the response arrives while this run still holds the
 * lease it held throughout. Returns false when the lease was lost (the write
 * stays pending for settling).
 */
async function trackedWrite(
  lease: LeaseHandle,
  customerId: string,
  w: Omit<PendingWrite, 'id' | 'idempotencyKey' | 'at' | 'sendBy' | 'claimedAt'>,
  send: (opts: { idempotencyKey: string; timeout: number; maxNetworkRetries: 0 }) => Promise<unknown>,
): Promise<boolean> {
  const id = randomUUID();
  const at = Date.now();
  const write: PendingWrite = { ...w, id, idempotencyKey: `pm-reconcile:${customerId}:${id}`, at, sendBy: at + SEND_WINDOW_MS };
  await lease.renew();
  await lease.addPendingWrite(write);
  const remaining = write.sendBy! - Date.now();
  if (remaining <= 1_000) throw new SendWindowClosed();
  // On failure the write stays pending: its outcome is unknown.
  await send({ idempotencyKey: write.idempotencyKey, timeout: Math.min(remaining, 30_000), maxNetworkRetries: 0 });
  try {
    await lease.assertHeld(); // held throughout: nothing can have landed in between
    await lease.removePendingWrites([id]);
    return true;
  } catch (e) {
    if (!(e instanceof LeaseLost)) throw e;
    return false;
  }
}

/**
 * Reconcile one customer's duplicate cards under the customer lock.
 * `dry-run` computes and returns the plan, and reports pending writes and
 * any repair they need, without changing anything.
 *
 * Every write is a pending write (above). A run first settles the pending
 * writes earlier runs left (failed, died, or lost their lease mid-call),
 * and defers all cleanup while any is still in flight.
 */
export async function reconcileDuplicateCards(
  stripe: ReconcileStripe,
  customerId: string,
  opts: { mode: ReconcileMode; lock: CustomerLock; waitMs?: number },
): Promise<ReconcileResult | null> {
  if (opts.mode === 'off') return null;
  let lost = false;
  let writeError: unknown = null;
  const result = await opts.lock.run(customerId, async (lease) => {
    const pending = await lease.pendingWrites();
    let repaired: string | null = null;
    const deferred: string[] = [];
    if (opts.mode === 'apply') {
      const settlement = await settlePendingWrites(stripe, lease, customerId);
      repaired = settlement.repaired;
      for (const w of settlement.inFlight) deferred.push(`an earlier ${w.kind} write is still in flight`);
    } else if (pending.length) {
      deferred.push(`${pending.length} earlier write(s) not yet settled; apply mode settles and repairs them`);
    }

    const choiceAtPlan = (await lease.defaultChoice())?.seq ?? 0;
    const waitFor = await unresolvedReservation(stripe, lease, opts.mode === 'apply');
    const plan = planReconciliation(await readCustomerPaymentState(stripe, customerId));
    if (waitFor) deferred.push(waitFor);
    if (deferred.length) {
      plan.deferred.push(...deferred);
      plan.setDefault = null;
      plan.detach = [];
    }
    const result: ReconcileResult = {
      mode: opts.mode, plan, defaultSet: null, detached: [], skipped: [], repairedChoice: repaired,
      pendingWrites: opts.mode === 'apply' ? await lease.pendingWrites() : pending,
    };
    if (opts.mode !== 'apply' || plan.deferred.length > 0) return result;

    const choiceChanged = async () =>
      ((await lease.defaultChoice())?.seq ?? 0) !== choiceAtPlan ? 'a default was chosen after planning' : null;

    try {
      if (plan.setDefault) {
        // Re-point only if nothing changed since planning: the default is still
        // the copy it replaces, and the target is still that same card and still
        // what a subscription bills.
        const now = await readCustomerPaymentState(stripe, customerId);
        const target = now.methods.find((m) => m.id === plan.setDefault);
        const from = now.methods.find((m) => m.id === plan.fromDefault);
        const reason =
          now.unsettled.length > 0 ? `unsettled: ${now.unsettled.join('; ')}`
          : now.customerDefault !== plan.fromDefault ? 'the default changed after planning'
          : !target || !from || !sameCard(target, from) ? 'no longer the same card'
          : (now.references.get(target.id) ?? []).length === 0 ? 'no longer referenced'
          : await choiceChanged();
        if (reason) {
          // The plan was made from state that no longer holds: change nothing
          // now, and let the next event or the sweep plan from fresh state.
          result.skipped.push({ id: plan.setDefault, reason });
          for (const d of plan.detach) result.skipped.push({ id: d.id, reason: 'plan superseded' });
          plan.detach = [];
        } else {
          const to = plan.setDefault;
          lost = !(await trackedWrite(lease, customerId, { kind: 'set-default', target: to, sinceSeq: choiceAtPlan },
            (o) => stripe.customers.update(customerId, { invoice_settings: { default_payment_method: to } }, o)));
          result.defaultSet = to;
        }
      }
      for (const { id, duplicateOf } of plan.detach) {
        if (lost) {
          result.skipped.push({ id, reason: 'lease lost' });
          continue;
        }
        // Re-read before each irreversible step; skip on any change.
        const now = await readCustomerPaymentState(stripe, customerId);
        const pm = now.methods.find((m) => m.id === id);
        const keeper = now.methods.find((m) => m.id === duplicateOf);
        const reason =
          now.unsettled.length > 0 ? `unsettled: ${now.unsettled.join('; ')}`
          : !pm ? 'no longer attached'
          : !keeper || !sameCard(pm, keeper) ? 'keeper missing or no longer the same card'
          : (now.references.get(id) ?? []).length > 0 ? `now referenced by ${now.references.get(id)!.join(', ')}`
          : now.customerDefault === id ? 'is the customer default'
          : await unresolvedReservation(stripe, lease, true) ?? await choiceChanged();
        if (reason) {
          result.skipped.push({ id, reason });
          continue;
        }
        lost = !(await trackedWrite(lease, customerId, { kind: 'detach', target: id, sinceSeq: choiceAtPlan },
          (o) => stripe.paymentMethods.detach(id, {}, o)));
        result.detached.push(id);
      }
    } catch (e) {
      if (e instanceof LeaseLost) lost = true;
      else writeError = e; // the write stays pending; its outcome is settled by a later run
    }
    return result;
  }, { waitMs: opts.waitMs });

  if (result && (lost || writeError)) {
    // Settle now if possible (claiming this run's own keys); if that fails
    // too, the pending writes stay recorded for the next run.
    try {
      const settlement = await opts.lock.run(customerId, (lease) => settlePendingWrites(stripe, lease, customerId), { waitMs: 30_000 });
      result.repairedChoice = settlement.repaired ?? result.repairedChoice;
      result.pendingWrites = settlement.remaining; // watches too: the caller schedules their revisit
    } catch (e) {
      if (!writeError) throw e;
    }
  }
  if (writeError) throw writeError;
  return result;
}

/**
 * Re-apply the latest console choice recorded since `sinceSeq`, as the console
 * route applied it (customer default, and active subscriptions when it did),
 * each write itself tracked. If the chosen copy was detached, an attached copy
 * of the same card stands in. Returns the method applied, or null when no
 * choice was made meanwhile.
 */
async function restoreUnder(stripe: ReconcileStripe, lease: LeaseHandle, customerId: string, sinceSeq: number): Promise<string | null> {
  const choice = await lease.defaultChoice();
  if (!choice || choice.seq <= sinceSeq) return null;
  const state = await readCustomerPaymentState(stripe, customerId);
  const target = state.methods.find((m) => m.id === choice.paymentMethodId)
    ?? (choice.fingerprint ? state.methods.find((m) => m.type === 'card' && m.card?.fingerprint === choice.fingerprint) : undefined);
  if (!target) return null; // the card itself is gone; nothing to restore to
  if (state.customerDefault !== target.id) {
    await trackedWrite(lease, customerId, { kind: 'restore-default', target: target.id, sinceSeq: choice.seq },
      (o) => stripe.customers.update(customerId, { invoice_settings: { default_payment_method: target.id } }, o));
  }
  if (choice.subscriptions) {
    const subs = await stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 100 });
    for (const sub of subs.data) {
      const current = typeof sub.default_payment_method === 'string' ? sub.default_payment_method : sub.default_payment_method?.id ?? null;
      if (current === target.id) continue;
      await trackedWrite(lease, customerId, { kind: 'restore-subscription', target: sub.id, sinceSeq: choice.seq },
        (o) => stripe.subscriptions.update(sub.id, { default_payment_method: target.id }, o));
    }
  }
  return target.id;
}
