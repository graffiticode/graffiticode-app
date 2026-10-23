/**
 * A ready result can arrive before its hydration.
 *
 * Hosts deliver a tool result's `structuredContent` and its `_meta` separately,
 * and not always together: the first delivery can say `status: "ready"` with no
 * `_meta.graffiticode` (the item's data, links and render_id) at all. The renderer
 * used to settle on that first delivery, paint a content-less card ("Open it in
 * Graffiticode to view"), and ignore the later delivery that carried the content.
 * That was tolerable while the chat also printed the item; render_item now tells
 * proven widget hosts NOT to, so the widget must end up showing the content.
 *
 * Also pinned here: every hydrated render reports exactly one terminal outcome
 * beacon (`outcome=mounted|card`) carrying its `rid`, and only hydrated renders
 * report one — the `rid` arrives with the hydration, so nothing else could be
 * correlated to a render.
 *
 * The renderer is driven for real in jsdom, as in widget-frame.test.ts.
 */
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";

const L0176 = "https://l0176.graffiticode.org";
const dom = new JSDOM(`<!doctype html><html><body><div id="content"></div></body></html>`, {
  url: "https://mcp-app-0123.web-sandbox.oaiusercontent.com/",
  pretendToBeVisual: true,
});
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.ResizeObserver = class { observe() {} disconnect() {} };
g.__MCP_ORIGIN__ = "https://mcp.graffiticode.org";
g.__WIDGET_BUILD__ = "abcd1234";
// L0179 is "native" here; jsdom can't resolve its bundle, so its mount fails.
g.__NATIVE__ = ["L0176", "L0179"];
g.__FRAMED__ = [{ id: "L0176", origin: L0176 }];

type Beacon = { stage: string; q: Record<string, string> };
let beacons: Beacon[] = [];
g.__BEACON_SINK__ = (stage: string, q: Record<string, string>) => beacons.push({ stage, q });

const { startRenderer } = await import("../src/widget/browser/renderer.ts");

function fakeHost() {
  let cb: ((r: unknown) => void) | undefined;
  return {
    adapter: {
      onToolResult(f: (r: unknown) => void) { cb = f; },
      onTheme() {},
      async connect() {},
      openLink() {},
      notifyHeight() {},
    },
    deliver: (r: unknown) => cb?.(r),
  };
}

const RID = "11111111-2222-4333-8444-555555555555";
const RID2 = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const sc = (language: string, status = "ready") => ({
  item_id: "deck1", status, language, name: "French deck", view_url: "https://app.graffiticode.org/form/deck1",
});
// A flashcard deck (L0181, no native bundle here): the card shows its content.
const DECK = { cards: [{ front: "Bonjour", back: "Hello" }, { front: "Merci", back: "Thank you" }] };
const unhydrated = (language = "L0181") => ({ structuredContent: sc(language), meta: {} });
const hydrated = (rid = RID, language = "L0181", data: unknown = DECK, extra: Record<string, unknown> = {}) => ({
  structuredContent: sc(language),
  meta: { graffiticode: { data, render_id: rid, ...extra } },
});

const body = () => dom.window.document.body;
const text = () => body().textContent ?? "";
const outcomes = () => beacons.filter((b) => b.stage === "outcome");
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function start() {
  body().innerHTML = `<div id="content"></div>`;
  beacons = [];
  const host = fakeHost();
  startRenderer(host.adapter as never);
  return host;
}

test("hydrated on the first delivery: the content shows, with one outcome carrying the rid and widget build", async () => {
  const host = start();
  host.deliver(hydrated());
  await tick();
  assert.match(text(), /Bonjour/);
  assert.equal(outcomes().length, 1);
  assert.deepEqual(
    { outcome: outcomes()[0].q.outcome, rid: outcomes()[0].q.rid, wv: outcomes()[0].q.wv, late: outcomes()[0].q.late },
    { outcome: "card", rid: RID, wv: "abcd1234", late: undefined },
  );
  // Every beacon carries the build, and the diagnostics carry the rid too.
  assert.ok(beacons.every((b) => b.q.wv === "abcd1234"));
  assert.ok(beacons.find((b) => b.stage === "boot")?.q.rid === RID);
});

test("ready without its hydration, then with it: the content replaces the provisional card, one outcome", async () => {
  const host = start();
  host.deliver(unhydrated());
  await tick();
  assert.doesNotMatch(text(), /Bonjour/, "nothing to show yet");
  assert.match(text(), /French deck/, "but the name and the way out are there");
  assert.equal(outcomes().length, 0, "a provisional card is not an outcome");
  assert.equal(beacons.some((b) => b.stage === "boot"), false, "nor a boot");
  host.deliver(hydrated(RID2));
  await tick();
  assert.match(text(), /Bonjour/, "the later delivery's content is on screen");
  assert.equal(outcomes().length, 1);
  assert.equal(outcomes()[0].q.rid, RID2);
  assert.equal(outcomes()[0].q.late, undefined);
});

test("hydration that never arrives: one nohydration diagnostic, and no outcome", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const host = start();
    host.deliver(unhydrated());
    mock.timers.tick(4_999);
    assert.equal(beacons.some((b) => b.stage === "nohydration"), false);
    mock.timers.tick(2);
    assert.equal(beacons.filter((b) => b.stage === "nohydration").length, 1);
    host.deliver(unhydrated());
    mock.timers.tick(60_000);
    assert.equal(beacons.filter((b) => b.stage === "nohydration").length, 1, "at most once");
    assert.equal(outcomes().length, 0, "the user saw no content, so no outcome claims otherwise");
    assert.match(text(), /French deck/, "the provisional card stays");
  } finally {
    mock.timers.reset();
  }
});

test("hydration after the wait still renders: one outcome, flagged late; later deliveries are ignored", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const host = start();
    host.deliver(unhydrated());
    mock.timers.tick(6_000);
    assert.equal(beacons.filter((b) => b.stage === "nohydration").length, 1);
    host.deliver(hydrated());
    assert.match(text(), /Bonjour/, "the content arrives at six seconds and is shown");
    assert.equal(outcomes().length, 1);
    assert.deepEqual({ rid: outcomes()[0].q.rid, late: outcomes()[0].q.late }, { rid: RID, late: "1" });
    host.deliver(hydrated(RID2, "L0181", { cards: [{ front: "Autre", back: "Other" }] }));
    assert.doesNotMatch(text(), /Autre/, "settled: a further delivery changes nothing");
    assert.equal(outcomes().length, 1);
    assert.deepEqual(
      beacons.map((b) => b.stage).filter((s) => s !== "boot" && s !== "card"),
      ["nohydration", "outcome"],
      "the diagnostic and the outcome are the only other beacons",
    );
  } finally {
    mock.timers.reset();
  }
});

test("generating, then an unhydrated ready, then a hydrated ready: the content ends up on screen", async () => {
  const host = start();
  host.deliver({ structuredContent: sc("L0181", "generating"), meta: {} });
  await tick();
  host.deliver(unhydrated());
  await tick();
  host.deliver(hydrated());
  await tick();
  assert.match(text(), /Bonjour/);
  assert.equal(outcomes().length, 1);
});

test("a native mount that fails ends on the card: one outcome=card with the rid", async () => {
  const host = start();
  host.deliver(hydrated(RID, "L0179", { sheets: [] }));
  await tick(80);
  assert.equal(outcomes().length, 1);
  assert.deepEqual({ outcome: outcomes()[0].q.outcome, rid: outcomes()[0].q.rid }, { outcome: "card", rid: RID });
});

const frameResult = (rid = RID) => hydrated(rid, "L0176", {
  data: { type: "questions", data: { questions: [{ response_id: "r1", type: "mcq", stimulus: "Pick one" }] } },
  errors: [],
}, { frame_url: `${L0176}/form?source=parent` });
const frame = () => body().querySelector("iframe") as HTMLIFrameElement | null;
const post = (data: unknown) =>
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data, origin: L0176, source: frame()?.contentWindow as never }));

test("a framed render that reports ready: one outcome=mounted with the rid", () => {
  const host = start();
  host.deliver(frameResult());
  assert.equal(outcomes().length, 0, "the card shown while the frame loads is not the outcome");
  post({ type: "preview-ready" });
  assert.equal(outcomes().length, 1);
  assert.deepEqual({ outcome: outcomes()[0].q.outcome, rid: outcomes()[0].q.rid }, { outcome: "mounted", rid: RID });
});

test("a framed render that times out: one outcome=card with the rid", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const host = start();
    host.deliver(frameResult());
    mock.timers.tick(20_001);
    assert.equal(outcomes().length, 1);
    assert.deepEqual({ outcome: outcomes()[0].q.outcome, rid: outcomes()[0].q.rid }, { outcome: "card", rid: RID });
  } finally {
    mock.timers.reset();
  }
});
