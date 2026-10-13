/**
 * Every height the widget reports to ChatGPT must come from one measurement.
 *
 * SkybridgeHost used to have two reporters: the renderer sent
 * `body.scrollHeight + 24`, and a ResizeObserver sent bare `body.scrollHeight`.
 * ChatGPT resized the iframe to whichever spoke last. The bare value had no
 * slack, so the frame came up a sub-pixel short, grew a scrollbar, narrowed, and
 * L0179's horizontally scrolling grid turned that width change into a height
 * change — which the observer reported, and round it went. The spreadsheet
 * jittered in ChatGPT and nowhere else.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
(globalThis as Record<string, unknown>).window = dom.window;
(globalThis as Record<string, unknown>).document = dom.window.document;

/** A ResizeObserver the test can fire by hand. */
let fire: () => void = () => {};
(globalThis as Record<string, unknown>).ResizeObserver = class {
  constructor(cb: () => void) { fire = cb; }
  observe() {}
  disconnect() {}
};

/** jsdom does no layout; stand in for the document's measured box. */
let docHeight = 0;
dom.window.document.documentElement.getBoundingClientRect = () =>
  ({ height: docHeight }) as DOMRect;

const { SkybridgeHost } = await import("../src/widget/browser/host.ts");
const { contentHeight, HEIGHT_PAD_PX } = await import("../src/widget/browser/measure.ts");

function setup() {
  const sent: number[] = [];
  (dom.window as unknown as Record<string, unknown>).openai = {
    notifyIntrinsicHeight: (h: number) => sent.push(h),
  };
  return { host: new SkybridgeHost(), sent };
}

test("the observer reports the same measurement the renderer does", () => {
  const { host, sent } = setup();
  docHeight = 300.4;
  host.notifyHeight(contentHeight());
  fire(); // nothing changed — the observer's first callback must not disagree

  assert.deepEqual(sent, [301 + HEIGHT_PAD_PX], "one value, not a renderer value and an observer value");
});

test("the measurement rounds up, so the frame is never a sub-pixel short", () => {
  docHeight = 300.01;
  assert.equal(contentHeight(), 301 + HEIGHT_PAD_PX);
});

test("a one-pixel wobble is not forwarded; a real resize is", () => {
  const { host, sent } = setup();
  docHeight = 300;
  host.notifyHeight(contentHeight());
  docHeight = 301;
  fire();
  docHeight = 360;
  fire();

  assert.deepEqual(sent, [300 + HEIGHT_PAD_PX, 360 + HEIGHT_PAD_PX]);
});

test("notifyIntrinsicHeight is called as a method of window.openai", () => {
  // The host's implementation is a method and may read `this`. Passing it around
  // detached threw "Cannot read properties of undefined" inside render.
  const sent: number[] = [];
  const openai = {
    sent,
    notifyIntrinsicHeight(this: { sent: number[] }, h: number) { this.sent.push(h); },
  };
  (dom.window as unknown as Record<string, unknown>).openai = openai;
  const host = new SkybridgeHost();
  docHeight = 200;
  assert.doesNotThrow(() => host.notifyHeight(contentHeight()));
  docHeight = 250;
  assert.doesNotThrow(() => fire());
  assert.deepEqual(sent, [200 + HEIGHT_PAD_PX, 250 + HEIGHT_PAD_PX]);
});
