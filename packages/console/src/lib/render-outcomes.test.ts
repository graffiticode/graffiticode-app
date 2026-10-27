// node:test via tsx: `npm test`.
import test from "node:test";
import assert from "node:assert/strict";
import { correlate, formatAlert, parseBeacon, shouldAlert, type Render } from "./render-outcomes";

// Verbatim from production (mcp-service, 2026-10-27).
const LINES = {
  mounted: "[widget] beacon stage=outcome lang=L0186 rid=7dc232eb-c795-4b0e-a868-817c42bfdd6b outcome=mounted wv=72fb5499 current=1",
  remount: "[widget] beacon stage=outcome lang=L0186 rid=761306cc-adb5-430f-81da-f174a1b96db5 outcome=mounted wv=72fb5499 current=1",
};
const render = (rid: string, clientKind = "openai-mcp (Codex)"): Render => ({ rid, at: "2026-10-27T07:29:46.915Z", clientKind, lang: "L0186" });

test("parses a beacon's key=value fields wherever they come, lang= between stage= and rid=", () => {
  assert.deepEqual(parseBeacon(LINES.mounted), {
    stage: "outcome", lang: "L0186", rid: "7dc232eb-c795-4b0e-a868-817c42bfdd6b", outcome: "mounted", wv: "72fb5499", current: "1",
  });
  assert.equal(parseBeacon("[widget] beacon stage=outcome rid=x lang=L0180 outcome=card")?.outcome, "card");
  assert.equal(parseBeacon("unrelated line"), null);
});

test("a render is confirmed only by an outcome beacon with its rid", () => {
  const c = correlate(
    [render("7dc232eb-c795-4b0e-a868-817c42bfdd6b"), render("00000000-0000-4000-8000-000000000001")],
    [parseBeacon(LINES.mounted)!, parseBeacon(LINES.remount)!],
  );
  assert.equal(c.renders, 2);
  assert.equal(c.confirmed, 1);
  assert.equal(c.unconfirmed, 1);
  assert.equal(c.unconfirmedRenders[0].rid, "00000000-0000-4000-8000-000000000001");
});

test("a beacon without a rid is unattributable legacy traffic and never confirms a render", () => {
  const legacy = parseBeacon("[widget] beacon stage=outcome lang=L0186 outcome=mounted")!;
  const c = correlate([render("00000000-0000-4000-8000-000000000002")], [legacy, legacy]);
  assert.equal(c.legacyUnattributable, 2);
  assert.equal(c.confirmed, 0);
  assert.equal(c.unconfirmed, 1);
});

test("outcome=card is reported, not counted as unconfirmed; other stages are ignored", () => {
  const rid = "00000000-0000-4000-8000-000000000003";
  const c = correlate([render(rid)], [parseBeacon(`[widget] beacon stage=outcome lang=L0180 rid=${rid} outcome=card`)!, parseBeacon(`[widget] beacon stage=ready lang=L0180 rid=00000000-0000-4000-8000-000000000004`)!]);
  assert.deepEqual([c.card, c.unconfirmed, c.confirmed], [1, 0, 0]);
});

test("alerts at 3 unconfirmed, or over 20% of at least 5; never in the release grace period", () => {
  assert.equal(shouldAlert({ renders: 10, unconfirmed: 2 }, false), false);
  assert.equal(shouldAlert({ renders: 30, unconfirmed: 3 }, false), true);
  assert.equal(shouldAlert({ renders: 5, unconfirmed: 2 }, false), true);
  assert.equal(shouldAlert({ renders: 4, unconfirmed: 2 }, false), false);
  assert.equal(shouldAlert({ renders: 30, unconfirmed: 9 }, true), false);
});

test("the alert text names the counts, window and first renders", () => {
  const c = correlate([render("aaaaaaaa-0000-4000-8000-000000000000"), render("bbbbbbbb-0000-4000-8000-000000000000"), render("cccccccc-0000-4000-8000-000000000000")], []);
  assert.equal(formatAlert(c, new Date("2026-10-27T20:00:00Z"), new Date("2026-10-27T21:00:00Z")),
    "Graffiticode: 3 of 3 widget renders unconfirmed (no outcome beacon), 20:00-21:00Z. L0186 aaaaaaaa, L0186 bbbbbbbb, L0186 cccccccc");
});
