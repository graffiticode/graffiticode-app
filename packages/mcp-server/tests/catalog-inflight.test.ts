import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { __resetCatalogForTest, __setCatalogDeadlinesForTest, listLanguages } from "../src/api.js";

// The incident this pins, 2026-09-30: the startup warm-up's catalog fetch never settled,
// and every list_languages call joined that one in-flight promise, so discovery hung for
// every client (to Cloud Run's 300s request timeout) for eleven hours. get_language_info,
// which has no in-flight map, kept working the whole time.

const auth = { type: "freePlan", sessionId: "test" } as never;
const CATALOG = { data: { languages: [{ id: "0184", name: "L0184", description: "Charts", domains: [] }] } };
const realFetch = globalThis.fetch;
let calls = 0;

/** A fetch that never answers and ignores its abort signal — the wedged warm-up. */
const wedged = () => new Promise<Response>(() => {});
const healthy = async () => new Response(JSON.stringify(CATALOG), { status: 200 });

beforeEach(() => {
  __resetCatalogForTest();
  __setCatalogDeadlinesForTest({ fallbackMs: 50, coldMs: 100 });
  calls = 0;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const useFetch = (...impls: Array<() => Promise<Response>>) => {
  globalThis.fetch = (() => impls[Math.min(calls++, impls.length - 1)]()) as typeof fetch;
};

test("a caller is not held past its own deadline by a fetch that never settles", async () => {
  useFetch(wedged);
  const started = Date.now();
  await assert.rejects(listLanguages({ auth }), /temporarily unavailable.*Do NOT retry/s);
  assert.ok(Date.now() - started < 2_000, `answered in ${Date.now() - started}ms`);
});

test("a wedged refresh is replaced, not joined, once it outlives its deadline", async () => {
  useFetch(wedged, healthy);
  await assert.rejects(listLanguages({ auth }));
  // The first fetch is still pending forever; a later call must start its own.
  await new Promise((r) => setTimeout(r, 150));
  const languages = await listLanguages({ auth });
  assert.deepEqual(languages.map((l) => l.id), ["0184"]);
  assert.equal(calls, 2, "a second fetch was made");
});

test("callers inside the deadline still share one fetch", async () => {
  useFetch(healthy);
  const [a, b] = await Promise.all([listLanguages({ auth }), listLanguages({ auth })]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
});

test("with a last good catalog, a wedged refresh answers with it", async () => {
  useFetch(healthy);
  await listLanguages({ auth });
  // A search misses the per-key cache, so it must fetch; the fetch wedges.
  useFetch(wedged);
  const languages = await listLanguages({ auth, search: "chart" });
  assert.deepEqual(languages.map((l) => l.id), ["0184"]);
});

test("list_languages hands a phrase search to the console and keeps its ranking", async () => {
  const { handleListLanguages } = await import("../src/tools.js");
  let sent: any = null;
  globalThis.fetch = (async (_url: unknown, init: any) => {
    sent = JSON.parse(init.body).variables;
    const languages = sent.search
      ? [{ id: "0185", name: "L0185", description: "Fetch & shape data", domains: [] }, { id: "0184", name: "L0184", description: "Charts", domains: [] }]
      : CATALOG.data.languages;
    return new Response(JSON.stringify({ data: { languages } }), { status: 200 });
  }) as typeof fetch;
  // A phrase is not a substring of any catalog text; matching it locally returned nothing.
  const out: any = await handleListLanguages({ auth } as never, { search: "  fetch csv data and summarize " });
  assert.equal(sent.search, "fetch csv data and summarize");
  assert.deepEqual(out.languages.map((l: any) => l.id), ["L0185", "L0184"]);
});
