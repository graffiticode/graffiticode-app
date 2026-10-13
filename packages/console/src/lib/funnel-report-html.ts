// HTML for the funnel report page (src/pages/api/r/[token].ts).
//
// Rendered as a self-contained string rather than a React page: _app.tsx wraps
// every route except form/editor in AuthWrapper, so a page under src/pages/
// would demand sign-in and defeat the whole point of a signed link you can open
// from a text message. An API route returning text/html bypasses _app entirely.
//
// Mobile-first — this is opened on a phone from an SMS — and styled inline so
// there is no stylesheet request and no dependency on the app's Tailwind build.

import type { Digest, DayRollup, SplitDigest } from "./funnel-digest";

export interface DayPoint extends DayRollup {
  /** PT calendar date, YYYY-MM-DD. */
  date: string;
  /**
   * False for days before workspace/item events existed. Those columns are
   * unknown, not zero, and must not render as a measurement.
   */
  instrumented: boolean;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

/**
 * Dates on both ends when the window crosses a PT day, otherwise only on the
 * start. A week-long window rendered with the end's time alone reads as a
 * one-hour window on the start date.
 */
function fmtRange(d: Digest): string {
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  };
  const day = (x: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(x);
  const endOpts = day(d.from) === day(d.to) ? { ...opts, month: undefined, day: undefined } : opts;
  return `${new Intl.DateTimeFormat("en-US", opts).format(d.from)} – ${new Intl.DateTimeFormat(
    "en-US",
    endOpts,
  ).format(d.to)} PT`;
}

function stat(label: string, value: number | string, hint?: string): string {
  return `<div class="stat"><div class="v">${esc(String(value))}</div><div class="l">${esc(
    label,
  )}</div>${hint ? `<div class="h">${esc(hint)}</div>` : ""}</div>`;
}

/**
 * Categorical bars are scaled by the TOTAL, not the largest value.
 *
 * Max-scaling makes the top row 100% by definition, so a table of four
 * languages at one item each rendered as four full-width bars — every chart
 * looked maxed out and carried no information. Share-of-total gives them 25%
 * each and reads as the proportion it actually is. Time series still scale by
 * max (see sparkTable); that's the right convention for a trend.
 */
function rows(map: Record<string, number>): string {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!entries.length) return `<p class="none">none</p>`;
  const total = entries.reduce((sum, [, v]) => sum + v, 0) || 1;
  return `<table>${entries
    .map(
      ([k, v]) =>
        `<tr><td class="k">${esc(k)}</td><td class="bar"><span style="width:${(
          (v / total) *
          100
        ).toFixed(1)}%"></span></td><td class="n">${v}</td></tr>`,
    )
    .join("")}</table>`;
}

/**
 * Requests we refused (or, in shadow mode, merely noticed) because the PROMPT
 * was not written in English.
 *
 * Titled "Prompt language" and kept apart from "By language" deliberately —
 * that section means the Graffiticode DIALECT, this one the natural language the
 * request was typed in. Same word, two different axes; one shared section title
 * would make the report lie.
 */
function promptLanguageRows(d: Digest): string {
  if (d.nonEnglish.total === 0) return `<p class="none">none</p>`;
  const note = d.nonEnglish.blocked > 0
    ? `${d.nonEnglish.blocked} of ${d.nonEnglish.total} refused`
    : `${d.nonEnglish.total} observed, none refused (shadow)`;
  return `${rows(d.nonEnglish.byLang)}<p class="none">${esc(note)}</p>`;
}

function section(title: string, body: string): string {
  return `<section><h2>${esc(title)}</h2>${body}</section>`;
}

/**
 * How far each client that connected actually got: connect → catalog listed →
 * guide read → tool called.
 *
 * This replaces a parenthetical that read "N probes filtered" and hid the
 * single largest thing the logs know. Most of those connects are agent hosts
 * that opened a transport, took the catalog and never called anything — the top
 * of the funnel, and the number that instruction and positioning work is meant
 * to move. Self-identifying automation is collapsed to one line beneath rather
 * than dropped, so a NEW crawler still shows up instead of silently joining the
 * filtered pile.
 *
 * Deliberately numeric, no bars: this is a drop-off across a row, and a bar per
 * row invites reading down the column instead of across it.
 */
function reachRows(d: Digest): string {
  const entries = Object.entries(d.reach.byClient).sort(
    (a, b) => b[1].connects - a[1].connects || a[0].localeCompare(b[0]),
  );
  const mid = d.reach.instrumented;
  const notes: string[] = [];
  if (d.reach.crawlers.sessions) {
    const named = Object.entries(d.reach.crawlers.byName)
      .sort((a, b) => b[1] - a[1])
      // Scanners identify themselves with a full user-agent string; one of them
      // is 60 characters and wraps this footnote across a phone screen.
      .map(([k, v]) => `${k.length > 24 ? `${k.slice(0, 23)}…` : k} ${v}`)
      .join(", ");
    notes.push(`automated: ${d.reach.crawlers.sessions} — ${named}`);
  }
  if (d.reach.unnamed) notes.push(`unnamed: ${d.reach.unnamed} — client reported no name`);
  // Unknown, not zero. mcp_listed/mcp_resource postdate most of the log
  // history, and rendering 0 for a window that never measured them would state
  // that nobody looked.
  if (!mid) notes.push("– catalog and guide reads not instrumented in this window");
  const foot = notes.map((n) => `<p class="none">${esc(n)}</p>`).join("");

  if (!entries.length) return `<p class="none">no agent connects</p>${foot}`;

  const head =
    `<tr class="hd"><td class="k">client</td><td class="n">conn</td>` +
    (mid ? `<td class="n">list</td><td class="n">read</td>` : "") +
    `<td class="n">used</td></tr>`;
  const body = entries
    .map(
      ([k, r]) =>
        `<tr><td class="k">${esc(k)}</td><td class="n">${r.connects}</td>` +
        (mid ? `<td class="n">${r.listed}</td><td class="n">${r.read}</td>` : "") +
        `<td class="n${r.used ? "" : " zero"}">${r.used}</td></tr>`,
    )
    .join("");
  return `<table>${head}${body}</table>${foot}`;
}

/**
 * Language use: items that compiled, with attempts alongside.
 *
 * Bars are sized by attempts, not creations, so a language that was tried a lot
 * and produced nothing still shows up — that gap is the interesting case and
 * sizing by creations would render it as a sliver. A language with attempts but
 * zero creations is flagged.
 */
function languageRows(d: Digest): string {
  const keys = [
    ...new Set([...Object.keys(d.languages.attempted), ...Object.keys(d.languages.created)]),
  ];
  if (!keys.length) return `<p class="none">none</p>`;
  const val = (k: string) => Math.max(d.languages.attempted[k] ?? 0, d.languages.created[k] ?? 0);
  // Share of total, same reason as rows(): scaling by max made every language
  // with an equal count render full-width.
  const total = keys.reduce((sum, k) => sum + val(k), 0) || 1;
  return `<table>${keys
    .sort((a, b) => val(b) - val(a) || a.localeCompare(b))
    .map((k) => {
      const made = d.languages.created[k] ?? 0;
      const tried = d.languages.attempted[k] ?? 0;
      const stalled = tried > 0 && made === 0;
      return `<tr><td class="k">${esc(k)}</td><td class="bar"><span${
        stalled ? ' class="stalled"' : ""
      } style="width:${((val(k) / total) * 100).toFixed(1)}%"></span></td><td class="n">${made}</td><td class="n dim">${
        tried ? `/${tried}` : "&nbsp;"
      }</td></tr>`;
    })
    .join("")}</table><p class="none">made / attempted · bar = share of activity</p>`;
}

/**
 * Inline bar chart. Avoids a chart library and the CSP/asset weight one costs.
 *
 * Each bar is the day's total tool calls scaled by the week's max, with the
 * anonymous share filled solid inside it. One bar rather than two rows per day:
 * the question the trend answers is "how much of this is strangers", which a
 * part-of-whole fill states directly and two adjacent bars make you compute.
 */
function sparkTable(series: DayPoint[]): string {
  if (!series.length) return `<p class="none">no data</p>`;
  const max = Math.max(1, ...series.map((p) => p.toolCalls));
  const anyPre = series.some((p) => !p.instrumented);
  const body = series
    .map((p) => {
      const anonPct = p.toolCalls ? (p.anonToolCalls / p.toolCalls) * 100 : 0;
      return (
        `<tr><td class="k">${esc(p.date.slice(5))}</td><td class="bar"><span class="split" style="width:${
          (p.toolCalls / max) * 100
        }%"><i style="width:${anonPct.toFixed(1)}%"></i></span></td>` +
        `<td class="n">${p.anonToolCalls}</td><td class="n dim">/${p.toolCalls}</td>` +
        (p.instrumented
          ? `<td class="n dim">${p.anonWorkspaces}w</td><td class="n dim">${p.anonItems}i</td>`
          : `<td class="n dim">–</td><td class="n dim">–</td>`) +
        `</tr>`
      );
    })
    .join("");
  return (
    `<table class="trend">${body}</table>` +
    `<p class="none">anon / all tool calls · anon workspaces &amp; items · solid = anon share</p>` +
    (anyPre ? `<p class="none">– workspaces and items not yet instrumented on that day</p>` : "")
  );
}

// Deliberately no "first seen" section. The page aggregates with an empty
// `seen` set so a page load can't consume the next SMS's ⚑new flags, which
// means every client kind and country in the window looks novel here. Rendering
// that would state something false. Novelty belongs to the SMS, which holds the
// real prior state.
/*
 * Walls, signups, api keys and plan changes are NOT rendered.
 *
 * They are emitted by the console with no `app` field, so the MCP-only reader
 * drops them (see isMcpOrigin) and every one of them would be a structural zero.
 * A tile reading "walls 0" is a claim that no request was refused, which is a
 * different and stronger statement than "this report does not measure that" — so
 * the tiles are gone rather than pinned at zero. Claims survive because the
 * claim events (claim_view, claim_auth_shown, claim_email_submitted, claim) are
 * MCP-funnel events, and item failures survive because item_generation_failed
 * now carries `app`.
 */
function itemsHint(d: Digest): string | undefined {
  const parts: string[] = [];
  if (d.items.failed) parts.push(`${d.items.failed} failed`);
  if (d.items.outOfScope) parts.push(`${d.items.outOfScope} out of scope`);
  return parts.length ? parts.join(" · ") : undefined;
}

function digestBlock(d: Digest): string {
  const conv = d.claims.count
    ? `${d.claims.count} claim (+${d.claims.transferred} items)`
    : "";

  return `
  <div class="stats">
    ${stat("tool calls", d.context.toolCalls)}
    ${stat("workspaces", d.workspaces.total, `${d.reach.agentIdle} agents idle`)}
    ${stat("items", d.items.ok, itemsHint(d))}
    ${stat("edits", d.context.edits)}
    ${stat("views", d.context.views)}
  </div>
  ${section("Reach", reachRows(d))}
  ${section("By client", rows(d.workspaces.byClient))}
  ${section("By language", languageRows(d))}
  ${section("Prompt language", promptLanguageRows(d))}
  ${section(
    "Conversion",
    conv ? `<p class="big">${esc(conv)}</p>` : `<p class="none">none</p>`,
  )}
  ${d.truncated ? `<p class="warn">Read capped — counts are floors, not totals.</p>` : ""}`;
}

/**
 * The page title carries NO date range on purpose.
 *
 * SMS clients render it as a link-preview card beneath the message, where it
 * repeated the window the body's first line already states. The range still
 * appears on the page itself, under the heading.
 *
 * Keep the head free of any literal title-tag text in comments — preview
 * scrapers regex for it and would match the comment instead.
 */
/**
 * One segment's heading + block. `share` states this side's weight against the
 * window total, so a section reading "3 items" can't be mistaken for the whole.
 */
function segmentSection(title: string, d: Digest, total: Digest): string {
  const pct = total.context.toolCalls
    ? Math.round((d.context.toolCalls / total.context.toolCalls) * 100)
    : 0;
  return `<h1 class="seg">${esc(title)}</h1>
<p class="sub">${
    total.context.toolCalls ? `${pct}% of tool calls this window` : "no tool calls this window"
  }</p>
${digestBlock(d)}`;
}

/** A stat whose hint is the anon/signed-in split of the same number. */
function splitStat(label: string, anon: number, authed: number): string {
  return stat(label, anon + authed, `${anon} anon · ${authed} signed in`);
}

export function renderReport(input: {
  window: SplitDigest;
  today: SplitDigest;
  series: DayPoint[];
  generatedAt: Date;
}): string {
  const { window, today, series, generatedAt } = input;
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, nosnippet, noimageindex, noarchive">
<title>Graffiticode usage</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --dim:#666; --line:#e5e5e5; --bg:#fff; --accent:#2563eb; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8e8e8; --dim:#999; --line:#2a2a2a; --bg:#141414; --accent:#60a5fa; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:16px 14px 48px; background:var(--bg); color:var(--fg);
         font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         max-width:720px; margin-inline:auto; }
  h1 { font-size:17px; margin:0 0 2px; font-weight:600; }
  .sub { color:var(--dim); font-size:13px; margin:0 0 18px; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--dim);
       margin:22px 0 8px; font-weight:600; }
  .stats { display:grid; grid-template-columns:repeat(3,1fr); gap:1px; background:var(--line);
           border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  .stat { background:var(--bg); padding:12px 10px; }
  .stat .v { font-size:24px; font-weight:650; line-height:1.1; }
  .stat .l { font-size:11px; color:var(--dim); text-transform:uppercase; letter-spacing:.05em; margin-top:2px; }
  .stat .h { font-size:11px; color:var(--dim); margin-top:3px; }
  table { width:100%; border-collapse:collapse; }
  td { padding:5px 0; font-size:14px; vertical-align:middle; }
  td.k { white-space:nowrap; padding-right:10px; max-width:44%; overflow:hidden; text-overflow:ellipsis; }
  td.n { text-align:right; width:38px; font-variant-numeric:tabular-nums; }
  td.n.dim { color:var(--dim); font-size:12px; width:34px; }
  td.n.zero { color:var(--dim); }
  tr.hd td { font-size:10px; color:var(--dim); text-transform:uppercase; letter-spacing:.05em;
             padding-bottom:2px; }
  td.bar { width:100%; }
  td.bar span { display:block; height:7px; border-radius:4px; background:var(--accent); min-width:3px; }
  td.bar span.stalled { background:#dc2626; }
  /* Part-of-whole: the outer span is the day's total, the inner fill its anon share. */
  td.bar span.split { background:var(--line); }
  td.bar span.split i { display:block; height:100%; border-radius:4px; background:var(--accent); }
  h1.seg { margin-top:26px; }
  .none { color:var(--dim); font-size:14px; margin:4px 0; }
  .big { font-size:15px; margin:4px 0; }
  .warn { margin-top:16px; padding:9px 11px; border-radius:6px; font-size:13px;
          background:rgba(220,38,38,.1); color:#dc2626; }
  .tabs { display:flex; gap:6px; margin:20px 0 4px; }
  .tabs a { flex:1; text-align:center; padding:8px; font-size:13px; border:1px solid var(--line);
            border-radius:6px; text-decoration:none; color:var(--fg); }
  hr { border:0; border-top:1px solid var(--line); margin:26px 0 0; }
  footer { color:var(--dim); font-size:12px; margin-top:22px; }
</style>
</head><body>
<h1>Graffiticode usage</h1>
<p class="sub">${esc(fmtRange(window.all))}</p>
${/*
   Anonymous first: it is the demand signal the SMS reports. The signed-in side
   used to be mostly our own console authoring, which is why the split existed;
   now that the reader is MCP-only and our accounts are excluded, it means signed
   -in agents talking to us over MCP — a small but real segment. The two are
   disjoint by construction (see isAuthenticated) so they sum to the window
   total — no third section is needed and none is offered.
*/ ""}
${segmentSection("Anonymous — no sign-in", window.anon, window.all)}
<hr>
${segmentSection("Signed in — over MCP", window.authed, window.all)}
<hr>
<h1 style="margin-top:26px">Today so far</h1>
<p class="sub">since 00:00 PT</p>
<div class="stats">
  ${splitStat("tool calls", today.anon.context.toolCalls, today.authed.context.toolCalls)}
  ${splitStat("workspaces", today.anon.workspaces.total, today.authed.workspaces.total)}
  ${splitStat("items", today.anon.items.ok, today.authed.items.ok)}
  ${stat("claims", today.all.claims.count)}
</div>
<hr>
<h1 style="margin-top:26px">Last 7 days</h1>
<p class="sub">anonymous tool calls, by PT day</p>
${sparkTable(series)}
<footer>Generated ${esc(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(generatedAt),
  )} PT · link expires 30 days after issue</footer>
</body></html>`;
}

export function renderInvalid(): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, nosnippet, noimageindex, noarchive">
<title>Link not valid</title>
<style>
 :root { color-scheme: light dark; }
 body { margin:0; display:grid; place-items:center; min-height:100vh; padding:24px;
        font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; text-align:center; }
 p { color:#666; max-width:32ch; }
</style></head>
<body><div><h1>Link not valid</h1>
<p>This report link has expired or is not recognized. Report links are good for 30 days.</p>
</div></body></html>`;
}
