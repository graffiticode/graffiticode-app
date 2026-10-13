/**
 * L0014's native bundle mounts and reports the corpus.
 *
 * L0014 (TransLaTeX rule sets) is read-only: its Form reports how each test case in the rule
 * set's corpus translated and never calls `apply`. So unlike L0180, "it mounted" IS the claim
 * that matters — but it still has to be checked against the built bundle, because a clean
 * build has shipped a language that then fell through to the content card (see languages.ts).
 *
 * The fixture is the envelope L0014's `/compile` returns for a three-case corpus: one case
 * that matches, one that does not, and one with an empty expectation — which the Form shows
 * as "captured" rather than failed, because an empty expectation asserts nothing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const L0014_DATA = {
  data: {
    options: { data: {}, rules: { "?+?": ["%1 + %2"], "?": ["%1"] } },
    tests: [
      { score: 1, source: "1+2", actual: "1 + 2", expected: "1 + 2" },
      { score: -1, source: "1+2", actual: "1 + 2", expected: "wrong" },
      { score: -1, source: "x+y", actual: "x + y", expected: "" },
    ],
  },
  errors: [],
};

const dom = new JSDOM(`<!doctype html><html><body></body></html>`, {
  url: "https://mcp.graffiticode.org/",
  pretendToBeVisual: true,
});
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
// `navigator` is a getter-only global on modern Node, so it needs defineProperty.
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.MutationObserver = dom.window.MutationObserver;
g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
g.cancelAnimationFrame = (id: number) => clearTimeout(id);

/** Mount the built artifact — what the host actually loads — into a fresh root. */
async function mount(data: unknown) {
  const mod = (await import("../dist/widget/lang/L0014.mjs")) as {
    styles: string;
    mount: (el: unknown, data: unknown) => void;
  };
  const root = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(root);
  mod.mount(root, data);
  // React 18 renders asynchronously; a macrotask is enough to flush it.
  await new Promise((r) => setTimeout(r, 50));
  return { root, styles: mod.styles };
}

test("L0014 mounts the corpus as one row per case, with the tally", async () => {
  const { root, styles } = await mount(L0014_DATA);
  const text = root.textContent ?? "";
  assert.match(text, /1 passed · 1 failed · 1 captured/);
  assert.equal(root.querySelectorAll("tbody tr").length, 3);
  assert.match(text, /wrong/);
  assert.ok(styles.length > 0, "the bundle must carry the Form's CSS");
});

test("L0014 shows compile errors instead of the corpus", async () => {
  const { root } = await mount({ data: null, errors: [{ message: "Unknown word: rulez" }] });
  const text = root.textContent ?? "";
  assert.match(text, /Unknown word: rulez/);
  assert.equal(root.querySelectorAll("tbody tr").length, 0);
});
