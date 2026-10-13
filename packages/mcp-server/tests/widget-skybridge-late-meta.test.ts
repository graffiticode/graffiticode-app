/**
 * A Skybridge host may populate its two globals on different ticks.
 *
 * `window.openai.toolOutput` carries the tool's structuredContent;
 * `window.openai.toolResponseMetadata` carries `_meta`, and for `render_item`
 * that is the ONLY place the src/data a native mount needs exists — the
 * structuredContent is compact on purpose, so the answer key stays out of the
 * model transcript.
 *
 * Delivering on the first tick is therefore right, but keying the "is this new?"
 * check on structuredContent alone is not: the metadata lands later, the
 * structuredContent has not changed, and the later payload is dropped as a
 * duplicate. The widget shows the content card forever, never attempts a mount,
 * and leaves no bundle fetch in the logs to explain itself.
 *
 * Observed 2026-09-11 as the ChatGPT desktop/mobile split: the same L0173 chart
 * drew on mobile and fell back to the card on desktop, same client name, same
 * advertised metadata. A race, not a capability difference.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
(globalThis as Record<string, unknown>).window = dom.window;
(globalThis as Record<string, unknown>).document = dom.window.document;
(globalThis as Record<string, unknown>).ResizeObserver = class { observe() {} disconnect() {} };

const { SkybridgeHost } = await import("../src/widget/browser/host.ts");

const OUTPUT = { item_id: "abc", status: "ready", language: "L0173" };
const HYDRATION = { graffiticode: { data: { chart: "…" }, src: "chart …" } };

/** Let the connect() watch loop tick. Its interval is 2s; the first read is sync. */
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a payload whose metadata lands late is delivered again, with the metadata", async () => {
  const w = dom.window as unknown as Record<string, unknown>;
  w.openai = { toolOutput: OUTPUT };

  const host = new SkybridgeHost();
  const seen: Array<{ structuredContent: unknown; meta: Record<string, unknown> }> = [];
  host.onToolResult((r) => seen.push(r as never));
  await host.connect();

  assert.equal(seen.length, 1, "the first read delivers what is there");
  assert.deepEqual(seen[0].meta, {}, "…which is an output with no hydration payload yet");

  // The host populates the second global a beat later. structuredContent is
  // unchanged — that is exactly the case the old key could not see.
  (w.openai as Record<string, unknown>).toolResponseMetadata = HYDRATION;
  await tick(2500);

  assert.equal(seen.length, 2, "the late metadata must re-deliver, or no mount is ever attempted");
  assert.deepEqual(seen[1].meta, HYDRATION);
  assert.deepEqual(seen[1].structuredContent, OUTPUT, "the same result, now renderable");
});

test("a genuinely unchanged payload is still delivered only once", async () => {
  const w = dom.window as unknown as Record<string, unknown>;
  w.openai = { toolOutput: OUTPUT, toolResponseMetadata: HYDRATION };

  const host = new SkybridgeHost();
  const seen: unknown[] = [];
  host.onToolResult((r) => seen.push(r));
  await host.connect();
  await tick(2500);

  assert.equal(seen.length, 1, "a stable result must not re-render the panel every tick");
});
