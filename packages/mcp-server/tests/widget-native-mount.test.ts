/**
 * The native language bundles are INTERACTIVE, not pictures.
 *
 * Every `Form` in the language family is controlled: it holds the candidate's answer
 * in `state.data` and calls `state.apply(action)` to change it. Whether the widget
 * re-renders after that call is the whole difference between an assessment that
 * scores and one that looks right and does nothing — and nothing else in this repo
 * can tell those apart. The bundle builds, mounts, draws its options, reports a
 * non-empty height, and passes `renderer.ts`'s empty-mount check either way.
 *
 * That is exactly how it shipped: `mount()` built a plain object whose `apply`
 * reassigned a closure variable, so React never heard about the click. In the widget
 * an L0180 item rendered its options and then refused to select one; in
 * app.graffiticode.org the same component scored, because there `apply` is a
 * `useReducer` dispatch (see l0000-view's `View`).
 *
 * L0180 is the case under test because it computes its own result in the browser —
 * it ships `scoreChoice`, so a correct click must produce "Correct — 1 / 1 point"
 * with no network at all, which is what the widget's CSP (no `connectDomains`)
 * allows. A language whose feedback is computed by an upstream `/compile` round trip
 * cannot be asserted this way and is not covered here.
 *
 * The fixture is the verbatim `data` envelope from a real generated item
 * (`LFVcuydvvsorA6SUC7RJ`), envelope and all, so it also pins `unwrapEnvelope`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const L0180_DATA = {
  data: {
    interaction: {
      type: "choice",
      prompt: "Which gas do plants absorb from the air during photosynthesis?",
      minChoices: 0,
      maxChoices: 1,
      shuffle: false,
      options: [
        { id: "A", text: "Oxygen" },
        { id: "B", text: "Carbon dioxide" },
        { id: "C", text: "Nitrogen" },
        { id: "D", text: "Hydrogen" },
      ],
    },
    validation: {
      responseProcessing: "map_response",
      cardinality: "single",
      baseType: "identifier",
      points: 1,
      mapping: { B: { correct: true, points: 1 } },
      feedback: {
        A: "Oxygen is released by plants during photosynthesis, not absorbed.",
        C: "Nitrogen is not used by plants during photosynthesis.",
        D: "Hydrogen is not absorbed from the air by plants during photosynthesis.",
      },
    },
  },
  errors: [],
};

/** Install a DOM, mount the built bundle, and hand back a click-and-read harness. */
async function mountL0180() {
  const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, {
    url: "https://mcp.graffiticode.org/",
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  // `navigator` is a getter-only global on modern Node, so it needs defineProperty.
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  g.HTMLElement = dom.window.HTMLElement;
  g.Element = dom.window.Element;
  g.Node = dom.window.Node;
  g.MutationObserver = dom.window.MutationObserver;
  g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
  g.cancelAnimationFrame = (id: number) => clearTimeout(id);

  // The built artifact, not the source: this asserts what the host actually loads.
  const mod = (await import("../dist/widget/lang/L0180.mjs")) as {
    styles: string;
    mount: (el: unknown, data: unknown) => void;
  };
  const root = dom.window.document.getElementById("root")!;
  mod.mount(root, L0180_DATA);
  // React 18 renders asynchronously; a macrotask is enough to flush it.
  const settle = () => new Promise((r) => setTimeout(r, 50));
  await settle();

  return {
    text: () => root.textContent ?? "",
    async choose(id: string) {
      const input = root.querySelector(`input[value="${id}"]`);
      assert.ok(input, `no option input for ${id}`);
      input.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await settle();
    },
  };
}

test("L0180 mounts, and selecting an option scores it", async () => {
  const item = await mountL0180();
  assert.match(item.text(), /Which gas do plants absorb/);
  assert.doesNotMatch(item.text(), /point/, "must not score before anything is chosen");

  await item.choose("B");
  assert.match(item.text(), /Correct — 1 \/ 1 point/);
});

test("L0180 shows the distractor rationale for a wrong answer", async () => {
  const item = await mountL0180();
  await item.choose("A");
  assert.match(item.text(), /Not quite — 0 \/ 1 point/);
  assert.match(item.text(), /Oxygen is released by plants/);
});

/**
 * L0181's deck holds the flip and the position in React state, so a widget that mounts but
 * never re-renders shows the first front forever. Fixture is the real deck from a ChatGPT render.
 */
const L0181_DATA = {
  data: {
    theme: "light",
    instructions: "Flip each card to check your answer before the quiz.",
    title: "Water Cycle Quiz Review",
    cards: [
      { id: 0, front: "What happens during evaporation?", back: "Liquid water heats up and changes into water vapor." },
      { id: 1, front: "What happens during condensation?", back: "Water vapor cools in the air and forms tiny droplets." },
    ],
  },
  errors: [],
};

test("L0181 mounts, reveals the back, and advances to the next card", async () => {
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
  g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
  g.cancelAnimationFrame = (id: number) => clearTimeout(id);

  const mod = (await import("../dist/widget/lang/L0181.mjs")) as {
    mount: (el: unknown, data: unknown) => void;
  };
  const root = dom.window.document.getElementById("root")!;
  mod.mount(root, L0181_DATA);
  const settle = () => new Promise((r) => setTimeout(r, 50));
  const click = async (selector: string) => {
    const target = [...root.querySelectorAll(selector)].find((n) => !(n as HTMLButtonElement).disabled);
    assert.ok(target, `no clickable ${selector}`);
    target.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await settle();
  };
  await settle();

  const text = () => root.textContent ?? "";
  assert.match(text(), /What happens during (evaporation|condensation)\?/);
  const front = /evaporation/.test(text()) ? "evaporation" : "condensation";

  await click('[aria-label="Reveal the answer"]');
  assert.match(text(), front === "evaporation" ? /Liquid water heats up/ : /Water vapor cools/);

  await click('[aria-label="Next card"]');
  assert.match(text(), front === "evaporation" ? /during condensation\?/ : /during evaporation\?/);
});

/** L0182 is read-only: the set of ideas and the ranked response must both draw. */
test("L0182 mounts and shows the ideas and the ranked response", async () => {
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
  g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
  g.cancelAnimationFrame = (id: number) => clearTimeout(id);

  const mod = (await import("../dist/widget/lang/L0182.mjs")) as {
    mount: (el: unknown, data: unknown) => void;
  };
  const root = dom.window.document.getElementById("root")!;
  mod.mount(root, {
    data: {
      survey: {
        id: "team-focus",
        title: "What should the team focus on next?",
        instructions: "Pick up to two, most important first.",
        ideas: [
          { id: "i0", text: "Faster onboarding" },
          { id: "i1", text: "Fewer meetings" },
          { id: "i2", text: "Better documentation" },
        ],
        minChoices: 1,
        maxChoices: 2,
      },
      response: { selection: ["i2", "i0"], idea: "A shared team calendar" },
    },
    errors: [],
  });
  await new Promise((r) => setTimeout(r, 50));

  const text = root.textContent ?? "";
  assert.match(text, /Fewer meetings/);
  assert.match(text, /A shared team calendar/);
  assert.match(text, /Better documentation/);
  assert.doesNotMatch(text, /No response yet/, "the response must render, not the empty state");
});

/** L0185 is read-only: a list of flat records draws as a table of the data, nothing added. */
test("L0185 mounts and shows records as a table", async () => {
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
  g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
  g.cancelAnimationFrame = (id: number) => clearTimeout(id);

  const mod = (await import("../dist/widget/lang/L0185.mjs")) as {
    mount: (el: unknown, data: unknown) => void;
  };
  const root = dom.window.document.getElementById("root")!;
  mod.mount(root, {
    data: [
      { region: "West", orders: 2, revenue: 320.5 },
      { region: "North", orders: 2, revenue: 175.25 },
    ],
    errors: [],
  });
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(root.querySelectorAll("th").length, 3);
  const text = root.textContent ?? "";
  assert.match(text, /320\.5/);
  assert.match(text, /2 records · 3 fields/);
});

/**
 * A five-question quiz renders as a quiz, not as its own payload.
 *
 * A multi-question item is `data.activity.items[]`, a different shape from the
 * single item above. `l0180-view@0.1.0` had no activity support at all — the
 * string did not appear in the package — and every Form in the family prints
 * what it cannot parse, so in ChatGPT on 2026-09-18 a real quiz arrived as a
 * pretty-printed JSON blob with `boot` and `mounted` beacons both fired. The
 * mount was never the problem; the view was three commits behind its own source.
 *
 * Fixed by publishing `l0180-view@0.2.0` (and the `@graffiticode/l0180` core it
 * imports `matching` from, which had never been published at all). This asserts
 * the shape that broke, so a future view regression is caught here rather than
 * in a chat window.
 */
test("a multi-question activity renders its questions", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  // Getter-only global on modern Node; same treatment as the setup above.
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  g.HTMLElement = dom.window.HTMLElement;
  g.Element = dom.window.Element;
  g.Node = dom.window.Node;
  g.MutationObserver = dom.window.MutationObserver;
  g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
  g.cancelAnimationFrame = (id: number) => clearTimeout(id);

  const mod = (await import("../dist/widget/lang/L0180.mjs")) as {
    mount: (el: HTMLElement, data: unknown) => void;
  };
  const el = dom.window.document.getElementById("root") as unknown as HTMLElement;
  mod.mount(el, {
    activity: {
      items: [
        {
          id: 0,
          interaction: {
            type: "choice",
            maxChoices: 1,
            options: [
              { id: "A", text: "Water vapor turns into droplets, forming clouds." },
              { id: "B", text: "Liquid water becomes vapor." },
            ],
          },
          validation: { mapping: { A: { correct: true, points: 1 } } },
        },
        {
          id: 1,
          interaction: {
            type: "choice",
            maxChoices: 1,
            options: [
              { id: "A", text: "Evaporation" },
              { id: "B", text: "Condensation" },
            ],
          },
          validation: { mapping: { B: { correct: true, points: 1 } } },
        },
      ],
    },
  });
  await new Promise((r) => setTimeout(r, 300));

  const text = (el.textContent ?? "").trim();
  assert.doesNotMatch(text, /^[{[]/, "the view must not print its own payload");
  assert.match(text, /Question 1/, "the first item must render");
  assert.match(text, /Question 2/, "every item must render, not just the first");
  assert.match(text, /Water vapor turns into droplets/, "option text must reach the DOM");
});

/**
 * L0183 places an answer with a `response` action carrying `{cells}`, which only the package's
 * exported `reduce` folds into `interaction.cells`. Under the generic merge the answer landed
 * on the top level, the web never showed it, and Check scored nothing — so this pins the
 * build's use of `reduce`, not just that the web mounts.
 */
const L0183_DATA = {
  data: {
    title: "Mammals",
    interaction: {
      type: "concept-web",
      hub: { id: "hub", text: "Mammals" },
      nodes: [{ id: "n1", blank: true }, { id: "n2", text: "Whale" }],
      edges: [
        { id: "e1", from: "hub", to: "n1", style: "solid" },
        { id: "e2", from: "hub", to: "n2", style: "solid" },
      ],
      trays: { nodes: { items: [{ id: "c1", text: "Bat" }, { id: "c2", text: "Shark" }], align: "right" } },
      cells: { n1: {} },
    },
    validation: { points: 1, cells: { n1: { assess: { expected: "Bat", points: 1 }, pool: "p1" } } },
  },
  errors: [],
};

test("L0183 mounts, places a tray answer on a blank, and scores it", async () => {
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
  g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
  g.cancelAnimationFrame = (id: number) => clearTimeout(id);

  const mod = (await import("../dist/widget/lang/L0183.mjs")) as {
    mount: (el: unknown, data: unknown) => void;
  };
  const root = dom.window.document.getElementById("root")!;
  mod.mount(root, L0183_DATA);
  const settle = () => new Promise((r) => setTimeout(r, 50));
  const click = async (el: Element | undefined, what: string) => {
    assert.ok(el, `no ${what}`);
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await settle();
  };
  const buttons = () => [...root.querySelectorAll("button")];
  await settle();

  assert.match(root.textContent ?? "", /Whale/);
  const check = () => buttons().find((b) => b.textContent === "Check");
  assert.ok(check()?.disabled, "Check was enabled before every blank was filled");
  await click(buttons().find((b) => b.textContent === "Bat"), "tray item Bat");
  await click(root.querySelector('[aria-label="Blank, empty"]') ?? undefined, "empty blank");
  assert.ok(root.querySelector('[aria-label="Blank, holding Bat"]'), "Bat was not placed on the blank");
  assert.ok(!buttons().some((b) => b.textContent === "Bat" && b.getAttribute("aria-pressed") !== null), "Bat is still in the tray");

  // Checking is the widget's (l0000-view's CheckBar, fed the package's `score`), and the Form
  // gives nothing away until then: instant feedback is off unless the program asks for it.
  assert.ok(root.querySelector('[aria-label="Blank, holding Bat"]'), "feedback showed before Check");
  assert.ok(!check()?.disabled, "Check stayed disabled with every blank filled");
  await click(check(), "Check button");
  assert.match(root.textContent ?? "", /1 of 1 points/);
  assert.ok(root.querySelector('[aria-label="Blank, holding Bat, correct"]'), "Check did not show feedback");

  // Check is a toggle: pressing it again hides the score and the feedback.
  await click(check(), "Check button, pressed");
  assert.doesNotMatch(root.textContent ?? "", /of 1 points/);
  assert.ok(root.querySelector('[aria-label="Blank, holding Bat"]'), "a second press left the feedback showing");
  await click(check(), "Check button");

  // Any change hides the check again: return Bat to the tray.
  await click(root.querySelector('[aria-label="Blank, holding Bat, correct"]') ?? undefined, "filled blank");
  assert.doesNotMatch(root.textContent ?? "", /of 1 points/);
  assert.ok(root.querySelector('[aria-label="Blank, empty"]'), "the blank kept its verdict after a change");
});
