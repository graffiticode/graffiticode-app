// node:test via tsx: `npm test`.
import test from "node:test";
import assert from "node:assert/strict";
import { emailHash, emailShare, verifiedEmailHashes } from "./connection-sharing";

// Stands in for the auth service; records every request.
const withFetch = async (respond: (url: string, init: any) => any, run: (calls: string[]) => Promise<void>) => {
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push(String(url));
    return respond(String(url), init);
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = real;
  }
};
const json = (body: unknown, ok = true) => ({ ok, json: async () => body });

test("only the signed-in user's verified emails can claim a pending share", async () => {
  await withFetch(
    (_url, init) => {
      assert.equal(init.headers.Authorization, "user-token");
      return json({ data: { emails: [
        { email: "Me@Example.com", verifiedAt: "2026-10-01T00:00:00Z" },
        { email: "unverified@example.com", verifiedAt: null },
        { email: "me@example.com", verifiedAt: "2026-10-02T00:00:00Z" },
        { verifiedAt: "2026-10-02T00:00:00Z" },
      ] } });
    },
    async calls => {
      assert.deepEqual(await verifiedEmailHashes("user-token"), [emailHash("me@example.com")]);
      assert.equal(calls.length, 1);
      assert.match(calls[0], /\/linked-emails$/);
    },
  );
});

test("an unreachable or refusing auth service claims nothing", async () => {
  await withFetch(() => json({}, false), async () => assert.deepEqual(await verifiedEmailHashes("t"), []));
  await withFetch(() => { throw new Error("down"); }, async () => assert.deepEqual(await verifiedEmailHashes("t"), []));
});

test("an email share is always pending by hash, and never asks whether an account has the email (no enumeration)", async () => {
  await withFetch(() => { throw new Error("no lookup expected"); }, async calls => {
    assert.deepEqual(emailShare(" Someone@Example.com ", []), {
      recipientEmailHash: emailHash("someone@example.com"),
      recipientLabel: "someone@example.com",
    });
    assert.equal(calls.length, 0);
  });
  // The owner's own verified email is refused: that tells them only about themselves.
  assert.throws(() => emailShare("me@example.com", [emailHash("me@example.com")]), /already own/);
});
