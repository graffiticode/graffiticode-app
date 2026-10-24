import { test } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { verifyStripeEvent } from './stripe-webhook-verify';
import { STRIPE_API_VERSION } from '@graffiticode-app/core/lib/plans-config';

const stripe = new Stripe('sk_test_unused', { apiVersion: STRIPE_API_VERSION as never });
const payload = JSON.stringify({ id: 'evt_test', object: 'event', type: 'invoice.paid', data: { object: {} } });
const signedWith = (secret: string) => stripe.webhooks.generateTestHeaderString({ payload, secret });

test('accepts an event signed with the current secret', () => {
  const event = verifyStripeEvent(stripe, payload, signedWith('whsec_new'), ['whsec_new', 'whsec_old']);
  assert.equal(event.id, 'evt_test');
});

test('accepts an event signed with the previous secret during a roll', () => {
  const event = verifyStripeEvent(stripe, payload, signedWith('whsec_old'), ['whsec_new', 'whsec_old']);
  assert.equal(event.id, 'evt_test');
});

test('refuses the old secret once the previous secret is removed', () => {
  assert.throws(() => verifyStripeEvent(stripe, payload, signedWith('whsec_old'), ['whsec_new', undefined]));
});

test('refuses an event signed with neither secret, or a tampered payload', () => {
  assert.throws(() => verifyStripeEvent(stripe, payload, signedWith('whsec_other'), ['whsec_new', 'whsec_old']));
  assert.throws(() => verifyStripeEvent(stripe, payload + ' ', signedWith('whsec_new'), ['whsec_new']));
});

test('refuses when no secret is configured, and ignores an empty previous secret', () => {
  assert.throws(() => verifyStripeEvent(stripe, payload, signedWith('whsec_new'), [undefined, '']), /No webhook signing secret/);
  assert.equal(verifyStripeEvent(stripe, payload, signedWith('whsec_new'), ['whsec_new', '']).id, 'evt_test');
});
