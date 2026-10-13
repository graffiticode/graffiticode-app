// HTML for the corpus sweep report, opened from the weekly SMS link.
//
// The SMS can only carry a headline — "7 changed shape (L0175 L0176) of 110" — and the whole point
// of a sensitive alarm is that a person decides whether it matters. This page is where they decide,
// so it is built around the two questions actually being asked: what broke, and what changed and
// how. Everything that matched is a count, not a list.
//
// Same visual language as the funnel report (src/lib/funnel-report-html.ts): one column, system
// font, light/dark by preference, readable one-handed on a phone. Deliberately not sharing that
// module — its markup is built around funnel counters and windows, and generalizing it to serve
// both would leave one file answering to two very different reports.
import type { SweepResult, SweepRun } from "./corpus-sweep";

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const STYLE = `
 :root { color-scheme: light dark; --fg:#111; --dim:#666; --line:#e5e5e5; --bg:#fff; --accent:#2563eb;
         --bad:#dc2626; --warn:#b45309; --ok:#15803d; --chip:#f4f4f5; }
 @media (prefers-color-scheme: dark) {
   :root { --fg:#e8e8e8; --dim:#999; --line:#2a2a2a; --bg:#141414; --accent:#60a5fa;
           --bad:#f87171; --warn:#fbbf24; --ok:#4ade80; --chip:#1f1f22; }
 }
 * { box-sizing: border-box; }
 body { margin:0; padding:16px 14px 48px; background:var(--bg); color:var(--fg);
        font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
        max-width:720px; margin-inline:auto; }
 h1 { font-size:17px; margin:0 0 2px; font-weight:600; }
 .sub { color:var(--dim); font-size:13px; margin:0 0 18px; }
 h2 { font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--dim);
      margin:24px 0 8px; font-weight:600; }
 .stats { display:grid; grid-template-columns:repeat(3,1fr); gap:1px; background:var(--line);
          border:1px solid var(--line); border-radius:8px; overflow:hidden; }
 .stat { background:var(--bg); padding:12px 10px; }
 .stat .v { font-size:24px; font-weight:650; line-height:1.1; }
 .stat .l { font-size:11px; color:var(--dim); text-transform:uppercase; letter-spacing:.05em; margin-top:2px; }
 .v.bad { color:var(--bad); } .v.warn { color:var(--warn); } .v.ok { color:var(--ok); }
 .note { border:1px solid var(--line); border-left:3px solid var(--warn); border-radius:6px;
         padding:10px 12px; margin:18px 0; font-size:13px; color:var(--dim); }
 .row { border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin-bottom:8px; }
 .row .hd { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; }
 .lang { font-weight:650; }
 .ref { color:var(--dim); font-size:12px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
        overflow-wrap:anywhere; }
 .stage { font-size:11px; text-transform:uppercase; letter-spacing:.05em; padding:1px 6px;
          border-radius:99px; background:var(--chip); color:var(--dim); }
 .err { margin-top:6px; font-size:13px; color:var(--bad); overflow-wrap:anywhere; }
 .delta { margin-top:6px; font-size:13px; }
 .delta .k { color:var(--dim); }
 code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px;
        background:var(--chip); padding:1px 5px; border-radius:4px; overflow-wrap:anywhere; }
 .cmd { display:block; padding:10px 12px; background:var(--chip); border-radius:8px; margin-top:6px;
        font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; overflow-wrap:anywhere; }
 .prov { color:var(--dim); font-size:12px; margin-top:4px; }
 .none { color:var(--dim); font-size:14px; }
`;

function shell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, nosnippet, noimageindex, noarchive">
<title>${esc(title)}</title>
<style>${STYLE}</style></head>
<body>${body}</body></html>`;
}

function failedRow(r: SweepResult): string {
  return `<div class="row">
 <div class="hd"><span class="lang">L${esc(r.lang)}</span>
  <span class="stage">${esc(r.stage ?? "failed")}</span>
  <span class="ref">${esc(r.exampleRef)}</span></div>
 <div class="err">${esc(r.error)}</div>
</div>`;
}

function changedRow(r: SweepResult): string {
  const only = [
    r.onlyInBaseline?.length
      ? `<div class="delta"><span class="k">only in baseline:</span> <code>${esc(r.onlyInBaseline.join(" "))}</code></div>` : "",
    r.onlyInFresh?.length
      ? `<div class="delta"><span class="k">only in fresh:</span> <code>${esc(r.onlyInFresh.join(" "))}</code></div>` : "",
  ].filter(Boolean).join("");
  // Both empty is meaningful, not missing: identical vocabulary, different counts or arrangement.
  const deltas = only || `<div class="delta"><span class="k">same vocabulary, different counts or arrangement</span></div>`;
  return `<div class="row">
 <div class="hd"><span class="lang">L${esc(r.lang)}</span>
  <span class="ref">${esc(r.exampleRef)}</span>
  ${r.degraded ? `<span class="stage">raw compare</span>` : ""}</div>
 ${deltas}
 <div class="prov">baseline ${r.baselineModel ? esc(r.baselineModel) : "<em>unrecorded</em>"} → fresh ${esc(r.freshModel ?? "?")}</div>
</div>`;
}

export function renderSweepReport(run: SweepRun): string {
  const total = run.results.length;
  const failed = run.results.filter((r) => r.verdict === "failed");
  const changed = run.results.filter((r) => r.verdict === "structure");

  const affected = [...new Set([...failed, ...changed].map((r) => r.lang))];
  const cmd = affected.length
    ? `npm run corpus-sweep -- --langs ${affected.join(",")}`
    : null;

  // A shape change on a row with no recorded baseline model cannot be separated from a model
  // switch. Saying so on the page matters more than in the SMS, because this is where somebody
  // decides whether to spend a full sweep on it.
  const unattributed = changed.filter((r) => !r.baselineModel).length;

  const when = new Date(run.at);
  const title = run.mode === "sample" ? `Corpus sweep wk${run.week}` : `Corpus sweep (full)`;

  const body = `
<h1>${esc(title)}</h1>
<p class="sub">${esc(when.toUTCString())} · ${esc(run.mode)} · ${total} prompts · ${run.langs.length} languages</p>

<div class="stats">
 <div class="stat"><div class="v ok">${run.match}</div><div class="l">match</div></div>
 <div class="stat"><div class="v ${run.structure ? "warn" : ""}">${run.structure}</div><div class="l">changed shape</div></div>
 <div class="stat"><div class="v ${run.failed ? "bad" : ""}">${run.failed}</div><div class="l">failed</div></div>
</div>

${cmd ? `<h2>Investigate</h2>
<p class="sub" style="margin:0">Regenerate every prompt for the affected languages and compare across the whole corpus.</p>
<code class="cmd">${esc(cmd)}</code>` : ""}

${unattributed > 0 ? `<div class="note"><strong>${unattributed} of ${changed.length} changed rows have no baseline model recorded.</strong>
For those, a shape change cannot be told apart from a model switch — the corpus row predates provenance
being written. Rows generated from now on carry the model and dialect that produced them.</div>` : ""}

<h2>Failed — ${failed.length}</h2>
${failed.length ? failed.map(failedRow).join("") : `<p class="none">None. Every prompt generated and compiled.</p>`}

<h2>Changed shape — ${changed.length}</h2>
${changed.length
  ? `<p class="sub" style="margin:0 0 8px">The program differs structurally from the corpus entry. Differing invented
     literals alone are not listed here — those count as a match.</p>` + changed.map(changedRow).join("")
  : `<p class="none">None. Every regenerated program matched its corpus entry.</p>`}
`;
  return shell(title, body);
}

export function renderSweepMissing(): string {
  return shell("Report not found", `<div style="display:grid;place-items:center;min-height:70vh;text-align:center">
 <div><h1>Report not found</h1>
 <p class="sub" style="max-width:34ch">This sweep report link has expired or is not recognized. Links are good for 30 days.</p></div>
</div>`);
}
