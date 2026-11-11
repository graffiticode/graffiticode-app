import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountLabel } from './account-label';

test('an account shows its email, else a shortened wallet, else its uid', () => {
  const uid = '51333f547188cd677e9be2b578373cd190597e8b';
  assert.equal(accountLabel('ghi@example.org', uid), 'ghi@example.org');
  assert.equal(accountLabel(null, uid), 'Wallet 0x5133…7e8b');
  assert.equal(accountLabel('', 'some-other-uid'), 'some-other-uid');
});
