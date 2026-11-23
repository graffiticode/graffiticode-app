/**
 * An in-memory stand-in for the parts of Stripe the billing modules use, with
 * Stripe's semantics where they matter here: idempotency keys replay the
 * original response, a detached card loses its customer, a subscription whose
 * card needs 3D Secure or is declined is created `incomplete` under
 * allow_incomplete, and lists filter by customer and status.
 *
 * Card behaviour is chosen per payment method: `ok`, `auth` (3D Secure
 * required), `decline`, `processing`, or `throw` (the create call itself
 * raises a StripeCardError, after leaving the incomplete subscription).
 */
type Behaviour = 'ok' | 'auth' | 'decline' | 'processing' | 'throw';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const list = (data: any[]) => ({ object: 'list', data: clone(data), has_more: false, url: '' });

export class FakeStripe {
  private n = 0;
  private clock = 1_700_000_000;
  customersById = new Map<string, any>();
  pms = new Map<string, any>();
  behaviour = new Map<string, Behaviour>();
  subs = new Map<string, any>();
  invoicesById = new Map<string, any>();
  pis = new Map<string, any>();
  sis = new Map<string, any>();
  sessions = new Map<string, any>();
  schedules = new Map<string, any>();
  idem = new Map<string, any>();
  calls: string[] = [];
  /** Called before every customer-state read; tests use it to change state mid-flow. */
  onRead: (() => void) | null = null;

  id(prefix: string) { return `${prefix}_${++this.n}`; }
  tick() { return ++this.clock; }

  addCustomer(defaultPm: string | null = null) {
    const id = this.id('cus');
    this.customersById.set(id, { id, object: 'customer', invoice_settings: { default_payment_method: defaultPm } });
    return id;
  }
  addCard(customer: string | null, fingerprint: string | null, behaviour: Behaviour = 'ok', type = 'card') {
    const id = this.id('pm');
    this.pms.set(id, {
      id, object: 'payment_method', type, created: this.tick(), customer,
      card: type === 'card' ? { brand: 'visa', last4: '4242', fingerprint } : undefined,
    });
    this.behaviour.set(id, behaviour);
    return id;
  }
  addSubscription(customer: string, pm: string | null, status = 'active', metadata: Record<string, string> = {}) {
    const id = this.id('sub');
    this.subs.set(id, { id, object: 'subscription', customer, status, default_payment_method: pm, metadata, latest_invoice: null, created: this.tick() });
    return id;
  }
  addInvoice(customer: string, pm: string | null, status: string) {
    const id = this.id('in');
    this.invoicesById.set(id, { id, object: 'invoice', customer, status, default_payment_method: pm, payments: { data: [] } });
    return id;
  }
  addPaymentIntent(customer: string, pm: string | null, status: string) {
    const id = this.id('pi');
    this.pis.set(id, { id, object: 'payment_intent', customer, status, payment_method: pm, client_secret: `${id}_secret` });
    return id;
  }
  addSetupIntent(customer: string, pm: string | null, status: string) {
    const id = this.id('seti');
    this.sis.set(id, { id, object: 'setup_intent', customer, status, payment_method: pm });
    return id;
  }
  openCheckout(customer: string) {
    const id = this.id('cs');
    this.sessions.set(id, { id, object: 'checkout.session', customer, mode: 'subscription', status: 'open' });
    return id;
  }
  /**
   * The customer pays on the hosted page. As on Stripe, only an open session
   * can complete; completing creates its subscription. Returns its id.
   */
  completeCheckout(id: string, pm: string | null = null) {
    const session = this.sessions.get(id);
    if (session.status !== 'open') throw Object.assign(new Error(`session ${id} is ${session.status}`), { type: 'StripeInvalidRequestError' });
    session.status = 'complete';
    if (session.mode !== 'subscription') return null;
    session.subscription = this.addSubscription(session.customer, pm, 'active');
    return session.subscription;
  }

  /** Settle a 3D Secure challenge the way Stripe.js would. */
  authenticate(piId: string, success: boolean) {
    const pi = this.pis.get(piId);
    // As on Stripe: once the invoice is voided its payment is canceled and can't complete.
    if (pi.status === 'canceled') throw Object.assign(new Error(`payment ${piId} is canceled`), { type: 'StripeInvalidRequestError' });
    if (success) {
      pi.status = 'succeeded';
      const inv = [...this.invoicesById.values()].find((i) => i.payments.data.some((p: any) => p.payment.payment_intent === piId));
      inv.status = 'paid';
      [...this.subs.values()].find((s) => s.latest_invoice === inv.id).status = 'active';
    } else {
      pi.status = 'requires_payment_method';
      pi.last_payment_error = { message: 'Authentication failed.', code: 'payment_intent_authentication_failure' };
    }
  }

  private read() { this.onRead?.(); }

  /**
   * Stripe's idempotency for writes: a completed key replays its response, a
   * key reused for a different request is refused (StripeIdempotencyError),
   * and a key whose request is still executing answers 409. `inFlight` lets a
   * test pause a request after Stripe has accepted it and before it applies.
   */
  keyed = new Map<string, { endpoint: string; params: string; state: 'inflight' | 'done'; response?: any }>();
  inFlight: ((endpoint: string, key: string) => Promise<void>) | null = null;
  /** Events, as Stripe records them: each names the idempotency key of the request that caused it. */
  eventLog: any[] = [];
  private detachedFrom = new Map<string, string>();
  private emit(endpoint: string, params: unknown, key: string | null) {
    const [verb, id] = endpoint.split(' ');
    // An update with nothing in it changes nothing and emits nothing; a detach always changes state.
    if (verb !== 'detach' && (!params || Object.keys(params as object).length === 0)) return;
    // Shaped as Stripe sends them: a Customer names itself by id; a detached
    // method has no customer, which survives only in previous_attributes.
    const [type, data] =
      verb === 'detach' ? ['payment_method.detached', { object: { object: 'payment_method', id, customer: null }, previous_attributes: { customer: this.detachedFrom.get(id) ?? null } }]
      : verb === 'customers.update' ? ['customer.updated', { object: { object: 'customer', id }, previous_attributes: {} }]
      : ['customer.subscription.updated', { object: { object: 'subscription', id, customer: this.subs.get(id)?.customer ?? null }, previous_attributes: {} }];
    this.eventLog.push({ id: this.id('evt'), type, created: Math.floor(Date.now() / 1000), request: { id: this.id('req'), idempotency_key: key }, data });
  }
  private async idempotent<T>(opts: any, endpoint: string, params: unknown, apply: () => Promise<T>): Promise<T> {
    const key = opts?.idempotencyKey;
    if (!key) {
      const out = await apply();
      this.emit(endpoint, params, null);
      return out;
    }
    const seen = this.keyed.get(key);
    if (seen) {
      if (seen.state === 'inflight') throw Object.assign(new Error('a request with this key is in progress'), { type: 'StripeIdempotencyError', statusCode: 409 });
      if (seen.endpoint !== endpoint || seen.params !== JSON.stringify(params ?? {})) {
        throw Object.assign(new Error('Keys for idempotent requests can only be used with the same parameters'), { type: 'StripeIdempotencyError', statusCode: 400 });
      }
      return clone(seen.response);
    }
    const entry = { endpoint, params: JSON.stringify(params ?? {}), state: 'inflight' as 'inflight' | 'done', response: undefined as any };
    this.keyed.set(key, entry);
    try {
      await this.inFlight?.(endpoint, key);
      const out = await apply();
      this.emit(endpoint, params, key);
      entry.state = 'done';
      entry.response = clone(out);
      return out;
    } catch (e) {
      this.keyed.delete(key);
      throw e;
    }
  }
  private withInvoice(sub: any, expand?: string[]) {
    const out = clone(sub);
    if (sub.latest_invoice && expand?.some((e) => e.includes('latest_invoice'))) out.latest_invoice = clone(this.invoicesById.get(sub.latest_invoice));
    return out;
  }
  private card(message: string, code: string) {
    return Object.assign(new Error(message), { type: 'StripeCardError', code, decline_code: code });
  }

  customers = {
    retrieve: async (id: string) => { this.calls.push('customers.retrieve'); this.read(); return clone(this.customersById.get(id)); },
    update: async (id: string, p: any, opts?: any) => this.idempotent(opts, `customers.update ${id}`, p, async () => {
      this.calls.push('customers.update');
      const c = this.customersById.get(id);
      if (p.invoice_settings) c.invoice_settings = { ...c.invoice_settings, ...p.invoice_settings };
      return clone(c);
    }),
  };

  paymentMethods = {
    list: async (p: any) => list([...this.pms.values()].filter((m) => m.customer === p.customer && (!p.type || m.type === p.type))),
    retrieve: async (id: string) => clone(this.pms.get(id)),
    detach: async (id: string, p?: any, opts?: any) => this.idempotent(opts, `detach ${id}`, p, async () => {
      this.calls.push(`detach ${id}`);
      const pm = this.pms.get(id);
      if (!pm.customer) throw Object.assign(new Error('not attached'), { type: 'StripeInvalidRequestError' });
      this.detachedFrom.set(id, pm.customer);
      pm.customer = null;
      for (const c of this.customersById.values()) if (c.invoice_settings.default_payment_method === id) c.invoice_settings.default_payment_method = null;
      for (const s of this.subs.values()) if (s.default_payment_method === id) s.default_payment_method = null;
      return clone(pm);
    }),
  };

  subscriptions = {
    list: async (p: any) => {
      const expand = (p.expand ?? []).map((e: string) => e.replace(/^data\./, ''));
      return list([...this.subs.values()]
        .filter((s) => s.customer === p.customer && (p.status === 'all' || !p.status ? true : s.status === p.status))
        .sort((a, b) => b.created - a.created)
        .map((s) => this.withInvoice(s, expand)));
    },
    retrieve: async (id: string, p: any = {}) => this.withInvoice(this.subs.get(id), p.expand),
    update: async (id: string, p: any, opts?: any) => this.idempotent(opts, `subscriptions.update ${id}`, p, async () => {
      this.calls.push(`subscriptions.update ${id}`);
      const s = this.subs.get(id);
      if ('default_payment_method' in p) s.default_payment_method = p.default_payment_method;
      return clone(s);
    }),
    cancel: async (id: string) => {
      this.calls.push(`cancel ${id}`);
      const s = this.subs.get(id);
      if (s.status === 'canceled' || s.status === 'incomplete_expired') throw Object.assign(new Error('already canceled'), { type: 'StripeInvalidRequestError' });
      // As Stripe does: canceling an incomplete subscription expires it.
      s.status = s.status === 'incomplete' ? 'incomplete_expired' : 'canceled';
      const inv = this.invoicesById.get(s.latest_invoice);
      if (inv && inv.status === 'open') inv.status = 'void';
      for (const pay of inv?.payments.data ?? []) {
        const pi = this.pis.get(pay.payment.payment_intent);
        if (pi && pi.status !== 'succeeded') pi.status = 'canceled';
      }
      return clone(s);
    },
    create: async (p: any, opts: any = {}) => {
      if (opts.idempotencyKey && this.idem.has(opts.idempotencyKey)) return clone(this.idem.get(opts.idempotencyKey));
      this.calls.push('subscriptions.create');
      const behaviour = this.behaviour.get(p.default_payment_method) ?? 'ok';
      const id = this.id('sub');
      const inv = this.addInvoice(p.customer, null, behaviour === 'ok' ? 'paid' : 'open');
      const piStatus = { ok: 'succeeded', auth: 'requires_action', decline: 'requires_payment_method', throw: 'requires_payment_method', processing: 'processing' }[behaviour];
      const pi = this.addPaymentIntent(p.customer, p.default_payment_method, piStatus);
      if (behaviour === 'decline' || behaviour === 'throw') this.pis.get(pi).last_payment_error = { message: 'Your card was declined.', code: 'card_declined', decline_code: 'generic_decline' };
      this.invoicesById.get(inv).payments.data.push({ payment: { type: 'payment_intent', payment_intent: pi } });
      this.subs.set(id, {
        id, object: 'subscription', customer: p.customer, status: behaviour === 'ok' ? 'active' : 'incomplete',
        default_payment_method: p.default_payment_method, metadata: p.metadata ?? {}, latest_invoice: inv, created: this.tick(),
        items: { data: (p.items ?? []).map((it: any, n: number) => ({
          id: `si_${id}_${n}`, price: { id: it.price, recurring: { interval: /annual|year/.test(it.price) ? 'year' : 'month', usage_type: 'licensed' } },
        })) },
      });
      if (behaviour === 'throw') {
        const err = this.card('Your card was declined.', 'card_declined');
        if (opts.idempotencyKey) this.idem.set(opts.idempotencyKey, this.withInvoice(this.subs.get(id), p.expand));
        throw err;
      }
      const out = this.withInvoice(this.subs.get(id), p.expand);
      if (opts.idempotencyKey) this.idem.set(opts.idempotencyKey, out);
      return clone(out);
    },
  };

  subscriptionSchedules = { list: async (p: any) => list([...this.schedules.values()].filter((s) => s.customer === p.customer)) };
  invoices = {
    list: async (p: any) => list([...this.invoicesById.values()].filter((i) => i.customer === p.customer)),
    retrieve: async (id: string) => clone(this.invoicesById.get(id)),
    voidInvoice: async (id: string) => {
      this.calls.push(`void ${id}`);
      const inv = this.invoicesById.get(id);
      if (inv.status !== 'open') throw Object.assign(new Error(`invoice ${id} is ${inv.status}`), { type: 'StripeInvalidRequestError' });
      inv.status = 'void';
      for (const pay of inv.payments.data) {
        const pi = this.pis.get(pay.payment.payment_intent);
        if (pi && pi.status !== 'succeeded') pi.status = 'canceled';
      }
      return clone(inv);
    },
  };
  paymentIntents = {
    list: async (p: any) => list([...this.pis.values()].filter((i) => i.customer === p.customer)),
    retrieve: async (id: string) => clone(this.pis.get(id)),
  };
  events = {
    list: async (p: any) => list(this.eventLog
      .filter((e) => (!p.types || p.types.includes(e.type)) && (!p.created?.gte || e.created >= p.created.gte))
      .slice().reverse()),
  };
  setupIntents = { list: async (p: any) => list([...this.sis.values()].filter((i) => i.customer === p.customer)) };
  checkout = {
    sessions: {
      list: async (p: any) => list([...this.sessions.values()].filter((s) => s.customer === p.customer && (!p.status || s.status === p.status))),
      create: async (p: any, opts: any = {}) => {
        const k = opts.idempotencyKey && `cs:${opts.idempotencyKey}`;
        if (k && this.idem.has(k)) return clone(this.idem.get(k));
        // Stripe validates expires_at against its own clock, and saves no result for a rejected request.
        if (p.expires_at != null && p.expires_at < Math.floor(Date.now() / 1000) + 1800) {
          throw Object.assign(new Error('expires_at must be at least 30 minutes from now'), { type: 'StripeInvalidRequestError', statusCode: 400, param: 'expires_at' });
        }
        this.calls.push('checkout.sessions.create');
        const id = this.id('cs');
        this.sessions.set(id, { id, object: 'checkout.session', customer: p.customer, mode: p.mode, status: 'open', expires_at: p.expires_at ?? null, url: `https://checkout.test/${id}`, subscription: null });
        const out = clone(this.sessions.get(id));
        if (k) this.idem.set(k, out);
        return clone(out);
      },
      retrieve: async (id: string) => clone(this.sessions.get(id)),
      expire: async (id: string) => {
        this.calls.push(`expire ${id}`);
        const s = this.sessions.get(id);
        if (s.status !== 'open') throw Object.assign(new Error(`session ${id} is ${s.status}`), { type: 'StripeInvalidRequestError' });
        s.status = 'expired';
        return clone(s);
      },
    },
  };

  /** Methods still attached to a customer. */
  attached(customer: string) { return [...this.pms.values()].filter((m) => m.customer === customer).map((m) => m.id).sort(); }
  defaultOf(customer: string) { return this.customersById.get(customer).invoice_settings.default_payment_method; }
  subsOf(customer: string, status?: string) { return [...this.subs.values()].filter((s) => s.customer === customer && (!status || s.status === status)); }
}
