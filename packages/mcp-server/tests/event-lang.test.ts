import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLang } from "../src/events.js";

// The privacy contract in src/events.ts promises no client-supplied string is
// ever written verbatim. `lang` is read off the free-text `language` tool
// argument, so it is a prompt channel unless something stops it — these are the
// actual values that reached Cloud Logging before it did.

test("a description passed as `language` never reaches the log", () => {
  assert.equal(
    normalizeLang("create a 3 by 3 table filled with random numbers"),
    "(invalid)",
  );
  assert.equal(normalizeLang("create a green bar chart using mock data\n"), "(invalid)");
});

test("junk is replaced, not truncated", () => {
  // A 200-char cap would still have written the first 200 characters of a prompt.
  const long = "make me a quiz about ".repeat(40);
  const out = normalizeLang(long);
  assert.equal(out, "(invalid)");
  assert.ok(!out!.includes("quiz"));
});

test("canonicalizes the prefix and case variants that fragmented the counts", () => {
  for (const v of ["L0173", "l0173", "0173", " 0173 "]) {
    assert.equal(normalizeLang(v), "L0173", `input ${JSON.stringify(v)}`);
  }
});

test("keeps real language ids", () => {
  assert.equal(normalizeLang("L0166"), "L0166");
  assert.equal(normalizeLang("0002"), "L0002");
});

test("absent stays absent — an unset language is not '(invalid)'", () => {
  assert.equal(normalizeLang(undefined), undefined);
  assert.equal(normalizeLang(""), undefined);
  assert.equal(normalizeLang(" "), "(invalid)");
});

test("near-misses that are not language ids are still rejected", () => {
  for (const v of ["en-US", "t", "kxz", "DUVvpEEK", "ZJHJVk", "\n"]) {
    assert.equal(normalizeLang(v), "(invalid)", `input ${JSON.stringify(v)}`);
  }
});

// The console joins its own funnel events to ours on `lang`. Two normalizers
// that disagreed would re-fragment exactly the counts this one exists to merge,
// so this mirrors console/src/lib/funnel-events.ts langKey().
test("agrees with the console's langKey on the shared shapes", () => {
  const langKey = (v: unknown): string | undefined => {
    if (typeof v !== "string" || !v) return undefined;
    const t = v.trim();
    if (/^\d{2,6}$/.test(t)) return `L${t}`;
    if (/^L\d{2,6}$/i.test(t)) return t.toUpperCase();
    return "(invalid)";
  };
  for (const v of ["L0166", "0166", "l0173", "en-US", "", " ", "a prompt here"]) {
    assert.equal(normalizeLang(v), langKey(v), `input ${JSON.stringify(v)}`);
  }
});
