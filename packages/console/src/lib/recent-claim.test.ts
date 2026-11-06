import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimedRecently, markClaimed, RECENT_CLAIM_KEY, RECENT_CLAIM_WINDOW_MS } from './recent-claim';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

test('a claim in this browser keeps consent sign-in only for the window', () => {
  const s = memory();
  const t = 1_800_000_000_000;
  assert.equal(claimedRecently(t, s), false);
  markClaimed(t, s);
  assert.equal(claimedRecently(t + 1000, s), true);
  assert.equal(claimedRecently(t + RECENT_CLAIM_WINDOW_MS - 1, s), true);
  assert.equal(claimedRecently(t + RECENT_CLAIM_WINDOW_MS, s), false);
});

test('missing, garbled, future or unreadable values count as no claim', () => {
  const s = memory();
  s.setItem(RECENT_CLAIM_KEY, 'nope');
  assert.equal(claimedRecently(1, s), false);
  s.setItem(RECENT_CLAIM_KEY, String(5000));
  assert.equal(claimedRecently(1000, s), false);
  assert.equal(claimedRecently(1, null), false);
  const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(claimedRecently(1, throwing), false);
  assert.doesNotThrow(() => markClaimed(1, throwing));
});
