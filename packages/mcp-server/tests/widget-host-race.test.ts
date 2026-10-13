/**
 * The widget must not commit to a transport it only GUESSED at.
 *
 * `createHost` used to be `window.openai ? Skybridge : ExtApps` — a one-shot
 * feature detect. That is wrong for any host which exposes `window.openai` while
 * speaking MCP Apps, and Codex is exactly that: it connects declaring
 * `[io.modelcontextprotocol/ui, openai/form]`.
 *
 * The failure had no symptom to debug from. Skybridge's read() looks for
 * `window.openai.toolOutput`; a host that never populates it makes read() return
 * null forever, so the watch loop spins for four minutes and nothing renders and
 * nothing explains why. The user sees a blank card, and the model — seeing only
 * the tool's text summary — reports that "Graffiticode returned the form as a
 * link rather than a native widget".
 */
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
(globalThis as Record<string, unknown>).window = dom.window;
(globalThis as Record<string, unknown>).document = dom.window.document;
(globalThis as Record<string, unknown>).ResizeObserver = class { observe() {} disconnect() {} };

const { RacingHost } = await import("../src/widget/browser/host.ts");

const RESULT = { structuredContent: { item_id: "abc", status: "ready" }, meta: {} };

/** A transport that answers, or one that never does. */
function fake(name: string, { answers }: { answers: boolean }) {
  const self = {
    name,
    cb: undefined as undefined | ((r: unknown) => void),
    connected: false,
    heights: [] as number[],
    opened: [] as string[],
    onToolResult(cb: (r: unknown) => void) { self.cb = cb; },
    onTheme(_cb: (t: string | undefined) => void) {},
    async connect() {
      self.connected = true;
      // A transport the host does not speak never resolves and never delivers.
      if (!answers) return new Promise<void>(() => {});
    },
    deliver(r: unknown) { self.cb?.(r); },
    openLink(url: string) { self.opened.push(url); },
    notifyHeight(px: number) { self.heights.push(px); },
  };
  return self;
}

test("an inert transport does not stop the other one delivering", async () => {
  // The Codex case: window.openai exists, so Skybridge is tried FIRST and is
  // inert. The result must still arrive, from the transport that answers.
  const inert = fake("skybridge", { answers: false });
  const live = fake("ext-apps", { answers: true });
  const host = new RacingHost([inert, live]);

  const seen: unknown[] = [];
  host.onToolResult((r: unknown) => seen.push(r));
  await host.connect();
  live.deliver(RESULT);

  assert.deepEqual(seen, [RESULT], "the answering transport delivered");
});

test("connect settles on the first transport to answer, not on all of them", async () => {
  // A transport the host does not speak never resolves. Awaiting both would hang
  // forever, which is the blank card by another route.
  const inert = fake("skybridge", { answers: false });
  const live = fake("ext-apps", { answers: true });
  const host = new RacingHost([inert, live]);
  await host.connect();          // must not hang
  assert.ok(inert.connected && live.connected, "both were attempted");
});

test("the first transport to deliver wins, and the loser is ignored", async () => {
  // Two live transports must not both re-render the panel; whichever spoke first
  // owns the surface.
  const a = fake("a", { answers: true });
  const b = fake("b", { answers: true });
  const host = new RacingHost([a, b]);
  const seen: unknown[] = [];
  host.onToolResult((r: unknown) => seen.push(r));
  await host.connect();

  a.deliver({ structuredContent: { from: "a" }, meta: {} });
  b.deliver({ structuredContent: { from: "b" }, meta: {} });
  a.deliver({ structuredContent: { from: "a2" }, meta: {} });

  assert.deepEqual(
    seen.map((s: any) => s.structuredContent.from),
    ["a", "a2"],
    "b was ignored after a won; a's later updates still flow",
  );
});

test("height is reported to every candidate until one wins", () => {
  // The winner may not be settled when the first measurement lands, and a host
  // ignores sizing for a transport it does not speak.
  const a = fake("a", { answers: true });
  const b = fake("b", { answers: true });
  new RacingHost([a, b]).notifyHeight(240);
  assert.deepEqual(a.heights, [240]);
  assert.deepEqual(b.heights, [240]);
});
