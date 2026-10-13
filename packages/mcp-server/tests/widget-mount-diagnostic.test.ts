/**
 * A fallback must SAY it fell back.
 *
 * Both native-mount failure paths used to write to console.error / console.warn
 * and then render the content card silently. Nobody watching a chat has a console
 * open, so the result was indistinguishable from a language that was never native
 * — which is exactly how this stayed unexplained: an L0173 chart drew on ChatGPT
 * mobile and fell back to the card on ChatGPT desktop, same client name, same
 * advertised metadata, same bundle fetched with a 200. The only difference anyone
 * could see was that one had a chart in it.
 *
 * The renderer is driven here for real rather than unit-testing a helper. jsdom
 * cannot resolve the `https://…/widget/lang/<id>.mjs` dynamic import, so the
 * throwing path is exercised end to end by the environment itself.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM(`<!doctype html><html><body><div id="content"></div></body></html>`, {
  url: "https://mcp.graffiticode.org/",
  pretendToBeVisual: true,
});
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.ResizeObserver = class { observe() {} disconnect() {} };
// Build-time globals the renderer is compiled against.
g.__MCP_ORIGIN__ = "https://mcp.graffiticode.org";
g.__NATIVE__ = ["L0173", "L0179"];

const { startRenderer } = await import("../src/widget/browser/renderer.ts");

/** A host adapter the test drives directly. */
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

const ready = (language: string) => ({
  structuredContent: {
    item_id: "abc123",
    status: "ready",
    language,
    name: "A Chart",
    view_url: "https://app.graffiticode.org/form/abc123",
  },
  meta: { graffiticode: { data: { interaction: { type: "chart" } } } },
});

async function renderAndSettle(language: string) {
  dom.window.document.body.innerHTML = `<div id="content"></div>`;
  const host = fakeHost();
  startRenderer(host.adapter as never);
  host.deliver(ready(language));
  // Let the failed dynamic import reject and the card render.
  await new Promise((r) => setTimeout(r, 60));
  return dom.window.document.body;
}

test("a failed native mount explains itself on the card", async () => {
  const body = await renderAndSettle("L0173");
  const note = body.querySelector(".card-note");
  assert.ok(note, "the card must carry a note when a native mount failed");
  assert.match(note!.textContent ?? "", /preview unavailable/i);
  // The cause is available without putting a stack trace on screen.
  assert.match(note!.getAttribute("title") ?? "", /L0173/);
  assert.match(note!.getAttribute("title") ?? "", /failed to mount/i);
});

test("the item itself is still presented — a degraded preview is not a broken item", async () => {
  const body = await renderAndSettle("L0173");
  assert.match(body.textContent ?? "", /A Chart/, "the item's name still shows");
  // Rendered as a button, not an anchor: a sandboxed frame cannot navigate
  // top-level, so the click goes through host.openLink.
  const link = body.querySelector("button.footer-link");
  assert.ok(link, "the way out to the item survives the fallback");
  assert.match(link!.textContent ?? "", /Open in Graffiticode/);
});

test("a language that is not native gets the card with NO note", async () => {
  // The distinction that was previously invisible: "never native" must not look
  // like "native and broken".
  const body = await renderAndSettle("L0182");
  assert.equal(body.querySelector(".card-note"), null);
  assert.match(body.textContent ?? "", /A Chart/);
});
