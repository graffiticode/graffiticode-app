// node:test via tsx: `npm test`.
import test from "node:test";
import assert from "node:assert/strict";
import { parseRecipient, shortId } from "./share-recipient";

test("a share names its recipient exactly: a full email or a full account ID, nothing partial", () => {
  const id = "ab".repeat(20);
  assert.deepEqual(parseRecipient(" Someone@Example.com "), { kind: "email", email: "someone@example.com" });
  assert.deepEqual(parseRecipient(`0x${id.toUpperCase()}`), { kind: "account", accountId: id });
  assert.deepEqual(parseRecipient(id), { kind: "account", accountId: id });
  for (const partial of ["", "so", "someone@", "someone@example", "Jeff", "abab", id.slice(1), `${id}0`]) {
    assert.equal(parseRecipient(partial), null, partial);
  }
  assert.equal(shortId(id), "ababab…abab");
});
