/**
 * The L0179 spreadsheet must not rebuild itself in a loop.
 *
 * L0179's grid (L0166's TableEditor, injected) is UNCONTROLLED: it seeds a
 * ProseMirror document from `interaction.cells` and rebuilds the whole grid — caret
 * back to A1 — whenever that object's IDENTITY changes. Its cell plugin reports
 * `response`/`update`/`focus` on every caret move, and L0179's reducer answers an
 * `update` with a fresh `cells` object by design.
 *
 * The widget's mount fed that straight back in (`formModel` "live", and no no-op
 * guard), so each rebuild reported a caret move, which produced new cells, which
 * rebuilt the grid. Measured against the pre-fix bundle in jsdom: 642 grid rebuilds
 * in two idle seconds, with no input at all. In ChatGPT desktop on 2026-10-06 that
 * was a sheet that visibly jittered and could not be typed into — every keystroke
 * landed in a grid that was about to be replaced.
 *
 * Fixed in scripts/build-widget.mjs as l0000-view's View does it: an action that
 * changes nothing returns the same state, and L0179/L0166 render from the model as
 * mounted (`formModel: "loaded"`, src/widget/languages.ts) while edits update the
 * live model that scoring reads.
 *
 * The signal is a <table> being inserted under the mount point: a re-seed replaces
 * the table node. A few inserts during mount are the editor building itself; after
 * that the count must stay flat, idle or not.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

test("L0179 settles after mount and stays put when the caret moves", async () => {
  const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, {
    url: "https://mcp.graffiticode.org/",
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  g.HTMLElement = dom.window.HTMLElement;
  g.Element = dom.window.Element;
  g.Node = dom.window.Node;
  g.MutationObserver = dom.window.MutationObserver;
  g.getComputedStyle = dom.window.getComputedStyle;
  g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
  g.cancelAnimationFrame = (id: number) => clearTimeout(id);

  // A blank 3×3 sheet — the item from the report.
  const cells: Record<string, { text: string }> = {};
  for (const c of "ABC") for (const r of [1, 2, 3]) cells[`${c}${r}`] = { text: "" };

  const mod = (await import("../dist/widget/lang/L0179.mjs")) as {
    mount: (el: unknown, data: unknown) => void;
  };
  const root = dom.window.document.getElementById("root")!;
  let rebuilds = 0;
  new dom.window.MutationObserver((records) => {
    for (const r of records) {
      for (const n of Array.from(r.addedNodes)) {
        if (n.nodeName === "TABLE" || (n as Element).querySelector?.("table")) rebuilds++;
      }
    }
  }).observe(root, { childList: true, subtree: true });

  mod.mount(root, { data: { interaction: { type: "table", columns: {}, rows: {}, cells } }, errors: [] });
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await settle(300);
  assert.equal(root.querySelectorAll("td").length, 9, "the 3×3 grid drew");

  const afterMount = rebuilds;
  await settle(500);
  assert.equal(rebuilds - afterMount, 0, "the grid kept rebuilding with no input (the jitter)");

  // Each Tab moves the caret, which fires response/update/focus from the cell plugin.
  const pm = root.querySelector(".ProseMirror")!;
  for (let i = 0; i < 4; i++) {
    pm.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", keyCode: 9, bubbles: true }));
    await settle(50);
  }
  await settle(200);
  assert.equal(rebuilds - afterMount, 0, "a caret move re-seeded the grid");
});
