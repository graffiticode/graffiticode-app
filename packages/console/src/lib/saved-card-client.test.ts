import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSavedCardPurchase, type PostResult, type SavedCardClientDeps } from './saved-card-client';

const BODY = { planId: 'pro', interval: 'monthly', paymentMethodId: 'pm_1', attemptKey: 'att_x', confirmed: true };

function deps(answers: PostResult[], over: Partial<SavedCardClientDeps> = {}) {
  const posts: any[] = [];
  const alerts: string[] = [];
  let challenges = 0;
  let checkouts = 0;
  const d: SavedCardClientDeps = {
    post: async (b) => { posts.push(b); const a = answers.shift(); if (!a) throw new Error('unexpected post'); return a; },
    confirmCardPayment: async () => { challenges++; return {}; },
    confirm: () => false,
    alert: (m) => { alerts.push(m); },
    startCheckout: async () => { checkouts++; },
    sleep: async () => {},
    ...over,
  };
  return { d, posts, alerts, challenges: () => challenges, checkouts: () => checkouts };
}
const action = { status: 200, data: { requiresAction: true, subscriptionId: 'sub_1', clientSecret: 'pi_secret' } };
const ok = { status: 200, data: { success: true } };

// Review #5, as reproduced: a Stripe.js error followed by a still-actionable payment.
test('a Stripe.js error never opens a second challenge', async () => {
  let challenges = 0;
  const t = deps([action, action, action], {
    confirmCardPayment: async () => { challenges++; return { error: { type: 'api_connection_error', message: 'Authentication interrupted' } }; },
  });
  let ended = 0;
  const out = await runSavedCardPurchase(t.d, BODY, () => { ended++; });
  assert.equal(out, 'auth_incomplete');
  assert.equal(challenges, 1);
  assert.equal(t.posts.length, 2); // the attempt, then one finalize
  assert.deepEqual(t.posts[1], { finalizeSubscriptionId: 'sub_1' });
  assert.match(t.alerts[0], /Authentication interrupted/);
  assert.match(t.alerts[0], /haven’t been charged/);
  assert.equal(ended, 0); // the key is kept, so choosing the plan again resumes this attempt
});

test('a thrown Stripe.js error is handled the same way', async () => {
  let challenges = 0;
  const t = deps([action, action], { confirmCardPayment: async () => { challenges++; throw new Error('network down'); } });
  assert.equal(await runSavedCardPurchase(t.d, BODY, () => {}), 'auth_incomplete');
  assert.equal(challenges, 1);
  assert.match(t.alerts[0], /network down/);
});

test('a challenge that fails ends declined, reported with Stripe.js’s reason, and can go on to Checkout', async () => {
  const declined = { status: 402, data: { declined: true, canceled: true } };
  const t = deps([action, declined], {
    confirmCardPayment: async () => ({ error: { type: 'card_error', message: 'We are unable to authenticate your payment method.' } }),
    confirm: (m) => /unable to authenticate/.test(m),
  });
  let ended = 0;
  assert.equal(await runSavedCardPurchase(t.d, BODY, () => { ended++; }), 'checkout');
  assert.equal(t.checkouts(), 1);
  assert.equal(ended, 1);
});

test('a completed challenge finalizes to active', async () => {
  const t = deps([action, ok]);
  let ended = 0;
  assert.equal(await runSavedCardPurchase(t.d, BODY, () => { ended++; }), 'active');
  assert.equal(t.challenges(), 1);
  assert.equal(ended, 1);
});

test('without Stripe.js, a required challenge is reported, not attempted', async () => {
  const t = deps([action], { confirmCardPayment: null });
  assert.equal(await runSavedCardPurchase(t.d, BODY, () => {}), 'auth_incomplete');
  assert.equal(t.posts.length, 1);
});

test('a decline without a challenge offers Checkout only when the user asks', async () => {
  const t = deps([{ status: 402, data: { declined: true, error: 'Your card was declined.' } }]);
  assert.equal(await runSavedCardPurchase(t.d, BODY, () => {}), 'declined');
  assert.equal(t.checkouts(), 0);
});

test('processing is polled through finalize and settles', async () => {
  const processing = { status: 202, data: { processing: true, subscriptionId: 'sub_1' } };
  const t = deps([processing, processing, ok]);
  assert.equal(await runSavedCardPurchase(t.d, BODY, () => {}), 'active');
  assert.equal(t.posts.length, 3);
});

test('processing that outlasts the polls is reported, not retried as a new purchase', async () => {
  const processing = { status: 202, data: { processing: true, subscriptionId: 'sub_1' } };
  const t = deps(Array.from({ length: 11 }, () => processing));
  assert.equal(await runSavedCardPurchase(t.d, BODY, () => {}), 'processing');
  assert.ok(t.posts.slice(1).every((b) => b.finalizeSubscriptionId === 'sub_1'));
});

test('busy and server errors end the purchase without opening a challenge', async () => {
  const busy = deps([{ status: 409, data: { busy: true } }]);
  assert.equal(await runSavedCardPurchase(busy.d, BODY, () => {}), 'busy');
  const broken = deps([{ status: 500, data: { error: 'boom' } }]);
  await assert.rejects(runSavedCardPurchase(broken.d, BODY, () => {}), /boom/);
  assert.equal(broken.challenges(), 0);
});
