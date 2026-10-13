/**
 * Host adapter — the one seam between the shared renderer and the two hosts.
 *
 * Claude (and other MCP Apps hosts) speak the ext-apps `App` bridge; ChatGPT
 * speaks `window.openai` (Skybridge). The renderer is written once against this
 * interface; each host gets a thin adapter. This is what lets a single native
 * renderer serve both, instead of the two drifting widgets we had before.
 *
 * Not compiled by tsc (browser-only) — bundled by scripts/build-widget.mjs.
 */
import { App } from "@modelcontextprotocol/ext-apps";
import { contentHeight } from "./measure.js";

export interface ToolResult {
  structuredContent: Record<string, unknown>;
  meta: Record<string, unknown>;
}

export interface HostAdapter {
  /** Complete the host handshake and return the initial tool result if one is ready. */
  connect(): Promise<void>;
  /** The tool result, delivered now if present and again whenever it changes. */
  onToolResult(cb: (r: ToolResult) => void): void;
  /** "light" | "dark" | undefined, delivered now and on change. */
  onTheme(cb: (theme: string | undefined) => void): void;
  /** Open a URL in a new tab via the host (sandboxed frames can't navigate top-level). */
  openLink(url: string): void;
  /** Report the content height so the host can size the view. */
  notifyHeight(px: number): void;
}

const windowOpenai = () =>
  (window as unknown as { openai?: Record<string, unknown> }).openai;

/** MCP Apps host (Claude et al.), wrapping the ext-apps App class. */
class ExtAppsHost implements HostAdapter {
  private app = new App({ name: "graffiticode-form", version: "1.0.0" });
  private toolCb?: (r: ToolResult) => void;
  private themeCb?: (t: string | undefined) => void;

  onToolResult(cb: (r: ToolResult) => void): void {
    this.toolCb = cb;
    // Register before connect so an early notification isn't missed.
    this.app.ontoolresult = (params) =>
      cb({
        structuredContent: (params.structuredContent ?? {}) as Record<string, unknown>,
        meta: (params._meta ?? {}) as Record<string, unknown>,
      });
  }

  onTheme(cb: (t: string | undefined) => void): void {
    this.themeCb = cb;
    this.app.onhostcontextchanged = (ctx) => cb(ctx.theme);
  }

  async connect(): Promise<void> {
    await this.app.connect();
    this.themeCb?.(this.app.getHostContext()?.theme);
  }

  openLink(url: string): void {
    this.app.openLink({ url }).catch(() => window.open(url, "_blank", "noopener"));
  }

  notifyHeight(): void {
    // The ext-apps App auto-reports size via a ResizeObserver; nothing to do.
  }
}

/** ChatGPT Apps host, wrapping window.openai (Skybridge). */
export class SkybridgeHost implements HostAdapter {
  private toolCb?: (r: ToolResult) => void;
  private ro?: ResizeObserver;
  private lastHeight?: number;

  private read(): ToolResult | null {
    const o = windowOpenai();
    if (!o) return null;
    const toolOutput = (o.toolOutput ?? o.props) as Record<string, unknown> | undefined;
    if (!toolOutput || Object.keys(toolOutput).length === 0) return null;
    const structuredContent = (toolOutput.structuredContent ?? toolOutput) as Record<string, unknown>;
    const meta = (o.toolResponseMetadata ?? toolOutput._meta ?? {}) as Record<string, unknown>;
    return { structuredContent, meta };
  }

  onToolResult(cb: (r: ToolResult) => void): void {
    this.toolCb = cb;
    // Skybridge exposes the result on a global rather than an event; the watch
    // loop started by connect() delivers it, and delivers again if it changes.
  }

  onTheme(cb: (t: string | undefined) => void): void {
    const o = windowOpenai();
    cb(o?.theme as string | undefined);
    // Skybridge re-renders the iframe on theme change, so a one-shot read suffices.
  }

  async connect(): Promise<void> {
    // Deliver the first result, then keep watching.
    //
    // This used to be a bare 120 x 500ms loop that, on exhaustion, simply fell out
    // and RESOLVED — no throw, so entry.ts's catch never fired and a timeout was
    // indistinguishable from a delivery. The panel stayed on "Loading…" forever.
    // That is the "stuck Generating…" report that put ChatGPT behind a whitelist.
    //
    // Two things changed. The wait is no longer the thing standing between the
    // user and a rendered panel — the renderer bounds that itself and shows a
    // truthful state — so this can watch for as long as a generation plausibly
    // runs (minutes, not one minute) without anyone staring at a spinner. And it
    // keeps watching AFTER the first delivery, because render_item answers
    // { status: "generating" } when its own poll deadline expires; without a
    // second delivery the widget would hold that first non-terminal answer
    // forever. That matches ExtAppsHost, whose contract already promises delivery
    // "again whenever it changes".
    let last = "";
    const deliver = (): boolean => {
      const r = this.read();
      if (!r) return false;
      // Cheap identity check: only re-deliver when the payload actually differs,
      // so a stable result doesn't re-render the panel every tick.
      //
      // The key covers `meta` as well as `structuredContent`, and that is the
      // whole point rather than thoroughness. The two arrive on SEPARATE globals
      // — `toolOutput` and `toolResponseMetadata` — and nothing promises they are
      // populated in the same tick. `render_item`'s structuredContent is compact
      // by design; the src/data a native mount needs lives ONLY in the metadata.
      // So a host that sets the output first delivers a payload with no render
      // data, the renderer correctly falls back to the content card, and then —
      // keyed on structuredContent alone — every later tick that DOES carry the
      // metadata is suppressed as a duplicate. The card is permanent, no mount is
      // attempted, and the logs show no bundle fetch to explain it.
      //
      // That is the ChatGPT desktop/mobile split observed 2026-09-11: the same
      // chart, the same client name, the same advertised metadata, drawn on
      // mobile and a card on desktop. It was never a host capability difference —
      // it is a race, and mobile happened to win it.
      const key = JSON.stringify([r.structuredContent, r.meta]);
      if (key === last) return true;
      last = key;
      this.toolCb?.(r);
      return true;
    };

    for (let i = 0; i < 40; i++) {
      if (deliver()) break;
      await new Promise((res) => setTimeout(res, 500));
    }

    // Background watch. Bounded so a forgotten panel doesn't poll indefinitely;
    // generously, because generation legitimately runs into the minutes.
    let ticks = 0;
    const timer = setInterval(() => {
      deliver();
      if (++ticks > 120) clearInterval(timer); // ~4 minutes at 2s
    }, 2000);
    // No-op in a browser, where setInterval returns a number. Under Node — which
    // is where this class is TESTED — the handle keeps the event loop alive, so a
    // test that exercises the watch loop would hang for the full four minutes
    // after its assertions have passed.
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  openLink(url: string): void {
    const o = windowOpenai() as { openExternal?: (a: { href: string }) => void } | undefined;
    if (o?.openExternal) o.openExternal({ href: url });
    else window.open(url, "_blank", "noopener");
  }

  notifyHeight(px: number): void {
    const o = windowOpenai() as { notifyIntrinsicHeight?: (h: number) => void } | undefined;
    if (!o?.notifyIntrinsicHeight) return;
    this.send(o, px);
    if (!this.ro) {
      // Same measurement as the renderer's reports (see measure.ts) — two
      // disagreeing reporters are what made the frame jitter.
      this.ro = new ResizeObserver(() => this.send(o, contentHeight()));
      this.ro.observe(document.body);
    }
  }

  private send(o: { notifyIntrinsicHeight?: (h: number) => void }, px: number): void {
    // A sub-pixel wobble is not a resize; forwarding it only invites the host to
    // re-lay out and the observer to fire again.
    if (this.lastHeight !== undefined && Math.abs(px - this.lastHeight) <= 1) return;
    this.lastHeight = px;
    // Called ON window.openai, never detached: it is the host's method and may use
    // `this`. A detached call throws inside render, after the mount.
    o.notifyIntrinsicHeight?.(px);
  }
}

/**
 * An adapter that tries BOTH transports and keeps whichever delivers.
 *
 * `window.openai ? Skybridge : ExtApps` was a one-shot guess, and it is wrong for
 * any host that exposes `window.openai` while speaking MCP Apps. Codex is exactly
 * that: it declares `[io.modelcontextprotocol/ui, openai/form]`. Committing to
 * Skybridge there means read() finds no `toolOutput` — not now, not ever — and the
 * watch loop spins for four minutes against a global the host never populates.
 * Nothing renders and nothing says why. That is the blank card.
 *
 * A guess is the wrong shape for this. The host knows which protocol it speaks and
 * answers when spoken to, so ask both and let the answer decide: whichever
 * delivers a tool result first wins, and the loser is dropped. Feature detection
 * still picks the ORDER — `window.openai` first when present — so the common case
 * costs nothing.
 */
export class RacingHost implements HostAdapter {
  private candidates: HostAdapter[];
  private winner?: HostAdapter;
  private toolCb?: (r: ToolResult) => void;
  private themeCb?: (t: string | undefined) => void;

  /** `candidates` is injectable so the race itself can be tested with fakes. */
  constructor(candidates?: HostAdapter[]) {
    this.candidates = candidates ?? (windowOpenai()
      ? [new SkybridgeHost(), new ExtAppsHost()]
      : [new ExtAppsHost(), new SkybridgeHost()]);
  }

  onToolResult(cb: (r: ToolResult) => void): void {
    this.toolCb = cb;
    for (const c of this.candidates) {
      c.onToolResult((r) => {
        // First delivery settles it. Later deliveries from the winner still flow;
        // the loser is ignored rather than torn down, since an adapter has no
        // disconnect and a stray late callback must not re-render from the
        // transport we did not choose.
        if (!this.winner) this.winner = c;
        if (this.winner === c) this.toolCb?.(r);
      });
    }
  }

  onTheme(cb: (t: string | undefined) => void): void {
    this.themeCb = cb;
    for (const c of this.candidates) c.onTheme((t) => this.themeCb?.(t));
  }

  async connect(): Promise<void> {
    // Settle as soon as EITHER connects; a transport the host does not speak may
    // never resolve, so waiting for both would wait forever.
    const attempts = this.candidates.map((c) =>
      c.connect().catch(() => { /* a transport this host does not speak */ }),
    );
    await Promise.race(attempts);
  }

  openLink(url: string): void {
    (this.winner ?? this.candidates[0]).openLink(url);
  }

  notifyHeight(px: number): void {
    // Height goes to every candidate: the winner may not be settled yet, and a
    // host ignores sizing for a transport it does not speak.
    for (const c of this.candidates) c.notifyHeight(px);
  }
}

/** Pick the adapter for the host we're running in. */
export function createHost(): HostAdapter {
  return new RacingHost();
}
