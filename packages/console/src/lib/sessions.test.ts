// node:test via tsx: `npm test`.
import test from "node:test";
import assert from "node:assert/strict";
import { authEndOtherSessions, authEndSession, authListSessions, describeUserAgent, listSessions, methodLabel, revokeSession } from "./sessions";

// Stands in for the auth service; records every request.
const withFetch = async (respond: (url: string, init: any) => any, run: (calls: { url: string; init: any }[]) => Promise<void>) => {
  const calls: { url: string; init: any }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = real;
  }
};
const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });

test("a user agent is named by browser and system", () => {
  const cases: [string | null, string][] = [
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36", "Chrome on macOS"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0", "Edge on Windows"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15", "Safari on macOS"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1", "Chrome on iOS"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0", "Firefox on Linux"],
    ["Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36", "Chrome on Android"],
    ["curl/8.7.1", "Unknown device"],
    [null, "Unknown device"],
  ];
  for (const [ua, label] of cases) assert.equal(describeUserAgent(ua), label, String(ua));
  assert.deepEqual([methodLabel("wallet"), methodLabel("email"), methodLabel("google"), methodLabel(null)], ["Wallet", "Email", "Google", "Sign-in"]);
});

test("the cookie's refresh token goes to auth in a header or a body, never the URL", async () => {
  await withFetch(
    () => json({ status: "success", data: [] }),
    async calls => {
      await authListSessions({ authorization: "id-token", refreshToken: "rt-secret" });
      await authEndOtherSessions({ authorization: "id-token", refreshToken: "rt-secret" });
      await authEndSession({ authorization: "id-token", id: "s/1" });
      await revokeSession("rt-secret");
      for (const c of calls) assert.doesNotMatch(c.url, /rt-secret/);
      assert.match(calls[0].url, /\/v1\/refresh-tokens\/sessions$/);
      assert.equal(calls[0].init.headers.Authorization, "id-token");
      assert.equal(calls[0].init.headers["X-Refresh-Token"], "rt-secret");
      assert.equal(calls[1].init.method, "DELETE");
      assert.deepEqual(JSON.parse(calls[1].init.body), { refreshToken: "rt-secret" });
      assert.match(calls[2].url, /\/sessions\/s%2F1$/);
      assert.match(calls[3].url, /\/v1\/refresh-tokens\/revoke$/);
      assert.deepEqual(JSON.parse(calls[3].init.body), { refreshToken: "rt-secret" });
    },
  );
  // Without a cookie, listing sends no X-Refresh-Token.
  await withFetch(
    () => json({ data: [] }),
    async calls => {
      await authListSessions({ authorization: "id-token", refreshToken: null });
      assert.equal(calls[0].init.headers["X-Refresh-Token"], undefined);
    },
  );
});

test("a failed or slow revoke never blocks sign-out", async () => {
  await withFetch(() => { throw new Error("ECONNREFUSED"); }, async () => {
    assert.equal(await revokeSession("rt"), false);
  });
  await withFetch(
    (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))),
    async () => {
      // AbortSignal.timeout's timer doesn't hold the event loop open; this does, for the test.
      const hold = setTimeout(() => {}, 2000);
      const started = Date.now();
      assert.equal(await revokeSession("rt", 50), false);
      assert.ok(Date.now() - started < 1000);
      clearTimeout(hold);
    },
  );
});

test("the page lists sessions through the console and reports auth's error", async () => {
  await withFetch(
    () => json({ status: "success", data: [{ id: "a", current: true }] }),
    async calls => {
      assert.deepEqual(await listSessions("id-token"), [{ id: "a", current: true }]);
      assert.equal(calls[0].url, "/api/sessions");
      assert.equal(calls[0].init.headers.Authorization, "id-token");
    },
  );
  await withFetch(() => json({ error: { message: "nope" } }, false), async () => {
    await assert.rejects(listSessions("id-token"), /nope/);
  });
});
