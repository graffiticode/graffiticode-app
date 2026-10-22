/**
 * L0176 is framed, not mounted: the widget shows l0176.graffiticode.org/form in an
 * iframe (free-plan items only) and trusts nothing but the page's own report.
 *
 * The page's shared View posts `onload` and `data-updated` on mount, before the
 * task loads or Learnosity initializes, so the widget must ignore them. Only
 * `preview-ready` (Learnosity's readyListener, posted by L0176's Form) counts,
 * and only from this frame: right origin AND right source window. A
 * `preview-error`, or silence until the deadline, falls back to the content card.
 *
 * The renderer is driven for real in jsdom, as in widget-mount-diagnostic.test.ts.
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
g.__NATIVE__ = ["L0176", "L0180"];
g.__FRAMED__ = [{ id: "L0176", origin: L0176 }];

const { startRenderer } = await import("../src/widget/browser/renderer.ts");
const { framedFormUrl } = await import("../src/tools.ts");

const FRAME_URL = `${L0176}/form?id=eyJ0YXNrSWRzIjpbIngiXX0`;

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

const result = (frame_url: unknown = FRAME_URL, language = "L0176") => ({
  structuredContent: { item_id: "vBSsho", status: "ready", language, name: "Presidents", view_url: "https://app.graffiticode.org/form/vBSsho" },
  meta: {
    graffiticode: {
      frame_url,
      data: { type: "questions", data: { questions: [{ response_id: "r1", type: "orderlist", stimulus: "Order them" }] } },
    },
  },
});

const body = () => dom.window.document.body;
const frame = () => body().querySelector("iframe") as HTMLIFrameElement | null;

function start(r: unknown = result()) {
  body().innerHTML = `<div id="content"></div>`;
  const host = fakeHost();
  startRenderer(host.adapter as never);
  host.deliver(r);
}

/** Posts a message to the widget as if it came from `source` at `origin`. */
function post(data: unknown, { origin = L0176, source = frame()?.contentWindow }: { origin?: string; source?: unknown } = {}) {
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data, origin, source: source as never }));
}

const tick = () => new Promise((r) => setTimeout(r, 20));

test("a framed result renders the page, with the widget's own origin appended", async () => {
  start();
  await tick();
  const f = frame();
  assert.ok(f, "an iframe is rendered");
  const src = new URL(f!.src);
  assert.equal(src.origin, L0176);
  assert.equal(src.pathname, "/form");
  assert.equal(src.searchParams.get("id"), "eyJ0YXNrSWRzIjpbIngiXX0");
  assert.equal(src.searchParams.get("origin"), "https://mcp-app-0123.web-sandbox.oaiusercontent.com");
  assert.equal(body().querySelector(".card"), null);
});

test("preview-ready from the frame keeps the frame", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    start();
    post({ type: "preview-ready" });
    mock.timers.tick(60_000);
    assert.ok(frame(), "the frame stays");
    assert.equal(body().querySelector(".card"), null);
  } finally {
    mock.timers.reset();
  }
});

test("an early onload followed by preview-error falls back to the card", async () => {
  start();
  post({ type: "onload", data: {} });
  post({ type: "data-updated", data: {} });
  assert.ok(frame(), "the View's mount messages change nothing");
  post({ type: "preview-error", reason: "learnosity: 10003" });
  assert.equal(frame(), null);
  const note = body().querySelector(".card-note");
  assert.ok(note, "the card says the preview is unavailable");
  assert.match(note!.getAttribute("title") ?? "", /L0176 framed preview failed: learnosity: 10003/);
  assert.match(body().textContent ?? "", /Order them/, "the card shows the item's content");
});

test("an early onload and then silence falls back to the card at the deadline", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    start();
    post({ type: "onload", data: {} });
    mock.timers.tick(19_000);
    assert.ok(frame(), "still waiting before the deadline");
    mock.timers.tick(1_500);
    assert.equal(frame(), null);
    assert.match(body().querySelector(".card-note")?.getAttribute("title") ?? "", /did not report ready/);
  } finally {
    mock.timers.reset();
  }
});

test("preview-ready from another origin, or another window, is ignored", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    start();
    post({ type: "preview-ready" }, { origin: "https://evil.example" });
    post({ type: "preview-ready" }, { source: dom.window });
    mock.timers.tick(21_000);
    assert.equal(frame(), null, "neither counted, so the deadline fell back");
    assert.ok(body().querySelector(".card"));
  } finally {
    mock.timers.reset();
  }
});

test("a frame_url on an undeclared origin is not framed", async () => {
  start(result("https://evil.example/form?id=x"));
  await tick();
  assert.equal(frame(), null);
});

test("a language that isn't framed ignores frame_url", async () => {
  start(result(`${L0176}/form?id=x`, "L0182"));
  await tick();
  assert.equal(frame(), null);
});

test("frame_url: free-plan L0176 only", () => {
  const free = { type: "freePlan", sessionId: "s" } as never;
  const signedIn = { type: "firebase", token: "t" } as never;
  assert.equal(framedFormUrl(free, "0176", "a+b"), `${L0176}/form?id=a%2Bb`);
  assert.equal(framedFormUrl(free, "L0176", "t1"), `${L0176}/form?id=t1`);
  assert.equal(framedFormUrl(signedIn, "0176", "t1"), null, "a private task can't load in a frame");
  assert.equal(framedFormUrl(free, "0180", "t1"), null, "only framed languages");
  assert.equal(framedFormUrl(free, "0176", null), null);
});
