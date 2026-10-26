#!/usr/bin/env node
/**
 * Daily cost of each Cloud Run service and Compute Engine resource, from the
 * billing export.
 *
 * Reads the detailed (resource-level) Cloud Billing export in
 * graffiticode.billing_export, which names the Cloud Run service or VM each
 * charge belongs to. Costs are net of credits (the free tier, sustained-use
 * discounts), so they add up to the invoice. Days are in the invoice's time zone,
 * America/Los_Angeles.
 *
 * The export lags usage by several hours, so the latest day is usually partial;
 * it is marked `*`. The export was created 2026-10-26 and Google backfilled it
 * from 2026-08-01 over the following hours; a range before the backfill finished
 * reads as zero, not as an error.
 *
 * Usage:
 *   npm run gcp-cost                          # last 7 days, both projects
 *   npm run gcp-cost -- --days 30
 *   npm run gcp-cost -- --start 2026-10-01 --end 2026-10-26
 *   npm run gcp-cost -- --project graffiticode-app --csv out.csv
 *   npm run gcp-cost -- --by-sku              # split each resource by SKU (CPU, memory, requests, ...)
 *   npm run gcp-cost -- --output cost.html    # also a self-contained HTML report: a stacked daily
 *                                             # chart and a shaded table per project
 *
 * Needs `bq` and read access to the export (the operator's gcloud login).
 */
import { execFileSync } from "child_process";
import { writeFileSync } from "fs";

const TABLE = "graffiticode.billing_export.gcp_billing_export_resource_v1_011D9E_92178F_7B5A59";
const TZ = "America/Los_Angeles";
const DEFAULT_PROJECTS = ["graffiticode", "graffiticode-app"];

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
};
const has = (name: string) => args.includes(`--${name}`);
const projects = args.flatMap((a, i) => (a === "--project" && args[i + 1] ? [args[i + 1]] : []));
const targets = projects.length ? projects : DEFAULT_PROJECTS;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const end = flag("end") ?? today;
const start = flag("start") ?? addDays(end, -(Number(flag("days") ?? 7) - 1));
for (const [name, value] of [["start", start], ["end", end]]) {
  if (!DATE.test(value)) throw new Error(`--${name} must be YYYY-MM-DD`);
}
for (const p of targets) {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(p)) throw new Error(`Not a project id: ${p}`);
}

// What a Compute Engine charge is for, so a VM's cores and RAM read as the VM
// and its disk as its disk.
const kind = `CASE
    WHEN service.description = 'Cloud Run' THEN 'run'
    WHEN sku.description LIKE '%Instance%' THEN 'vm'
    WHEN sku.description LIKE '%PD%' OR sku.description LIKE '%Storage%' OR sku.description LIKE '%Snapshot%' THEN 'disk'
    ELSE 'other' END`;
const sql = `
SELECT
  FORMAT_DATE('%F', DATE(usage_start_time, '${TZ}')) AS day,
  project.id AS project,
  ${kind} AS kind,
  COALESCE(resource.name, '(no resource)') AS resource,
  ${has("by-sku") ? "sku.description" : "''"} AS sku,
  SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS net
FROM \`${TABLE}\`
WHERE service.description IN ('Cloud Run', 'Compute Engine')
  AND project.id IN (${targets.map(p => `'${p}'`).join(", ")})
  AND DATE(usage_start_time, '${TZ}') BETWEEN DATE '${start}' AND DATE '${end}'
GROUP BY day, project, kind, resource, sku
HAVING ABS(net) >= 0.005`;

const out = execFileSync("bq", ["query", "--project_id=graffiticode", "--use_legacy_sql=false", "--format=json", "--max_rows=1000000", sql], {
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
});
const rows: Array<{ day: string; project: string; kind: string; resource: string; sku: string; net: string }> = JSON.parse(out || "[]");

// When the export's newest usage ends: days from then on are partial.
const fresh: Array<{ last: string | null }> = JSON.parse(execFileSync("bq", ["query", "--project_id=graffiticode", "--use_legacy_sql=false", "--format=json",
  `SELECT FORMAT_DATE('%F', DATE(MAX(usage_end_time), '${TZ}')) AS last FROM \`${TABLE}\``], { encoding: "utf8" }) || "[]");
const lastDay = fresh[0]?.last ?? null;

const days: string[] = [];
for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
const partial = (d: string) => lastDay === null || d >= lastDay;

type Line = { project: string; kind: string; resource: string; sku: string; byDay: Map<string, number>; total: number };
const lines = new Map<string, Line>();
for (const r of rows) {
  const key = [r.project, r.kind, r.resource, r.sku].join("\u0000");
  const line = lines.get(key) ?? { project: r.project, kind: r.kind, resource: r.resource, sku: r.sku, byDay: new Map(), total: 0 };
  const net = Number(r.net);
  line.byDay.set(r.day, (line.byDay.get(r.day) ?? 0) + net);
  line.total += net;
  lines.set(key, line);
}
const sorted = [...lines.values()].sort((a, b) => b.total - a.total);

if (flag("csv")) {
  const header = ["project", "kind", "resource", ...(has("by-sku") ? ["sku"] : []), ...days, "total"];
  const body = sorted.map(l => [l.project, l.kind, l.resource, ...(has("by-sku") ? [l.sku] : []),
    ...days.map(d => (l.byDay.get(d) ?? 0).toFixed(2)), l.total.toFixed(2)]);
  const csv = [header, ...body].map(r => r.map(c => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n");
  writeFileSync(flag("csv")!, `${csv}\n`);
  console.log(`wrote ${sorted.length} rows to ${flag("csv")}`);
}

// A table per project, widest-cost first; days as columns.
const money = (n: number) => (Math.abs(n) < 0.005 ? "-" : n.toFixed(2));
const dayHead = days.map(d => `${d.slice(5)}${partial(d) ? "*" : " "}`);
console.log(`Cloud Run and Compute Engine, net of credits, ${start} to ${end} (${TZ}).` +
  (lastDay ? ` Export has usage through ${lastDay}; * = partial day.` : " The export has no usage yet."));
for (const project of targets) {
  const mine = sorted.filter(l => l.project === project);
  const label = (l: Line) => `${l.kind === "run" ? "" : `[${l.kind}] `}${l.resource}${l.sku ? ` · ${l.sku}` : ""}`;
  const width = Math.max(24, ...mine.map(l => label(l).length));
  console.log(`\n${project}`);
  console.log(`${"".padEnd(width)}  ${dayHead.map(h => h.padStart(8)).join("")}   ${"total".padStart(9)}`);
  for (const l of mine) {
    console.log(`${label(l).padEnd(width)}  ${days.map(d => money(l.byDay.get(d) ?? 0).padStart(8)).join("")}   ${money(l.total).padStart(9)}`);
  }
  const dayTotals = days.map(d => mine.reduce((s, l) => s + (l.byDay.get(d) ?? 0), 0));
  console.log(`${"TOTAL".padEnd(width)}  ${dayTotals.map(t => money(t).padStart(8)).join("")}   ${money(dayTotals.reduce((a, b) => a + b, 0)).padStart(9)}`);
}

if (flag("output")) {
  writeFileSync(flag("output")!, renderHtml());
  console.log(`\nwrote ${flag("output")}`);
}

// The HTML report: per project, a stacked bar per day (the seven costliest
// resources, then "Other") and the full table with each day's cell shaded by
// cost. Colours are the dataviz skill's reference palette: categorical slots in
// fixed order (validated for adjacent pairs, light and dark), and a one-hue blue
// ramp for the table. Three light-mode slots sit under 3:1 on the surface, so the
// legend and the table carry every value as text.
function renderHtml(): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]!);
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const label = (l: Line) => `${l.kind === "run" ? "" : `[${l.kind}] `}${l.resource}${l.sku ? ` · ${l.sku}` : ""}`;
  const SLOTS = 8;
  const sections = targets.map(project => {
    const mine = sorted.filter(l => l.project === project);
    const total = mine.reduce((s, l) => s + l.total, 0);
    // Seven named resources in the fixed hue order; the rest fold into a neutral "Other".
    const series = mine.slice(0, SLOTS - 1).map((l, i) => ({ name: label(l), slot: i + 1, value: (d: string) => Math.max(0, l.byDay.get(d) ?? 0) }));
    const rest = mine.slice(SLOTS - 1);
    if (rest.length) {
      series.push({ name: `Other (${rest.length})`, slot: 0, value: (d: string) => Math.max(0, rest.reduce((s, l) => s + (l.byDay.get(d) ?? 0), 0)) });
    }
    const dayTotals = days.map(d => mine.reduce((s, l) => s + (l.byDay.get(d) ?? 0), 0));
    return { project, mine, total, series, dayTotals };
  });

  const chart = (s: (typeof sections)[number]) => {
    const W = 760, H = 240, left = 48, right = 8, top = 12, bottom = 28;
    const plotW = W - left - right, plotH = H - top - bottom;
    const max = Math.max(0.01, ...s.dayTotals);
    const step = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500].find(v => max / v <= 5) ?? 1000;
    const yMax = Math.ceil(max / step) * step;
    const y = (v: number) => top + plotH - (v / yMax) * plotH;
    const slotW = plotW / days.length;
    const barW = Math.min(36, Math.max(4, slotW * 0.62));
    const parts: string[] = [];
    for (let v = 0; v <= yMax + 1e-9; v += step) {
      parts.push(`<line class="grid" x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}"/>`,
        `<text class="tick" x="${left - 6}" y="${y(v) + 4}" text-anchor="end">$${v % 1 ? v.toFixed(1) : v}</text>`);
    }
    const labelEvery = Math.ceil(days.length / 15);
    days.forEach((d, i) => {
      const x = left + i * slotW + (slotW - barW) / 2;
      let base = 0;
      const stack = s.series.map(ser => ({ ser, v: ser.value(d) })).filter(p => p.v > 0);
      stack.forEach((p, k) => {
        const y0 = y(base), y1 = y(base + p.v);
        base += p.v;
        const h = Math.max(0, y0 - y1 - (k === stack.length - 1 ? 0 : 2)); // 2px surface gap between segments
        if (h < 0.5) return;
        const top = y0 - h;
        const r = k === stack.length - 1 ? Math.min(4, h, barW / 2) : 0;
        const tip = esc(`${d}${partial(d) ? " (partial)" : ""} · ${p.ser.name}: ${usd(p.v)} of ${usd(s.dayTotals[i])}`);
        const shape = r
          ? `<path d="M${x},${y0} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${y0} Z"`
          : `<rect x="${x}" y="${top}" width="${barW}" height="${h}"`;
        parts.push(`${shape} class="s${p.ser.slot}${partial(d) ? " partial" : ""}" data-tip="${tip}"/>`);
      });
      if (i % labelEvery === 0) parts.push(`<text class="tick" x="${x + barW / 2}" y="${H - 10}" text-anchor="middle">${d.slice(5)}${partial(d) ? "*" : ""}</text>`);
    });
    parts.push(`<line class="axis" x1="${left}" x2="${W - right}" y1="${y(0)}" y2="${y(0)}"/>`);
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily cost of ${esc(s.project)} by resource">${parts.join("")}</svg>`;
  };

  const table = (s: (typeof sections)[number]) => {
    const cellMax = Math.max(0.01, ...s.mine.flatMap(l => days.map(d => l.byDay.get(d) ?? 0)));
    const heat = (v: number) => (v < 0.005 ? "" : ` class="h${Math.min(5, Math.floor((v / cellMax) * 6))}"`);
    const head = `<tr><th>Resource</th>${days.map(d => `<th>${d.slice(5)}${partial(d) ? "*" : ""}</th>`).join("")}<th>Total</th></tr>`;
    const rows = s.mine.map(l => `<tr><td>${esc(label(l))}</td>${days.map(d => {
      const v = l.byDay.get(d) ?? 0;
      return `<td${heat(v)}>${Math.abs(v) < 0.005 ? "–" : v.toFixed(2)}</td>`;
    }).join("")}<td class="tot">${l.total.toFixed(2)}</td></tr>`).join("");
    const foot = `<tr class="foot"><td>Total</td>${s.dayTotals.map(t => `<td>${Math.abs(t) < 0.005 ? "–" : t.toFixed(2)}</td>`).join("")}<td class="tot">${s.total.toFixed(2)}</td></tr>`;
    return `<div class="scroll"><table><thead>${head}</thead><tbody>${rows}${foot}</tbody></table></div>`;
  };

  const legend = (s: (typeof sections)[number]) => s.series.map(ser =>
    `<li><span class="sw s${ser.slot}"></span>${esc(ser.name)} <span class="muted">${usd(days.reduce((a, d) => a + ser.value(d), 0))}</span></li>`).join("");

  const fullDays = days.filter(d => !partial(d)).length;
  const grand = sections.reduce((a, s) => a + s.total, 0);
  const tiles = [
    `<div class="tile"><div class="k">Total, ${days.length} days</div><div class="v">${usd(grand)}</div></div>`,
    ...sections.map(s => `<div class="tile"><div class="k">${esc(s.project)}</div><div class="v">${usd(s.total)}</div></div>`),
    fullDays ? `<div class="tile"><div class="k">Average full day</div><div class="v">${usd(sections.reduce((a, s) => a + days.reduce((b, d, i) => b + (partial(d) ? 0 : s.dayTotals[i]), 0), 0) / fullDays)}</div></div>` : "",
  ].join("");

  const LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
  const DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
  const HEAT_LIGHT = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7"];
  const HEAT_DARK = ["#0d366b", "#104281", "#184f95", "#1c5cab", "#256abf", "#2a78d6"];
  const vars = (mode: "light" | "dark") => {
    const [series, heat] = mode === "light" ? [LIGHT, HEAT_LIGHT] : [DARK, HEAT_DARK];
    const chrome = mode === "light"
      ? { page: "#f9f9f7", surface: "#fcfcfb", ink: "#0b0b0b", ink2: "#52514e", muted: "#898781", grid: "#e1e0d9", axis: "#c3c2b7", border: "rgba(11,11,11,0.10)", heatInk: "#0b0b0b", other: "#c3c2b7" }
      : { page: "#0d0d0d", surface: "#1a1a19", ink: "#ffffff", ink2: "#c3c2b7", muted: "#898781", grid: "#2c2c2a", axis: "#383835", border: "rgba(255,255,255,0.10)", heatInk: "#ffffff", other: "#5c5b57" };
    return `color-scheme:${mode};--page:${chrome.page};--surface:${chrome.surface};--ink:${chrome.ink};--ink2:${chrome.ink2};--muted:${chrome.muted};--grid:${chrome.grid};--axis:${chrome.axis};--border:${chrome.border};--heat-ink:${chrome.heatInk};--other:${chrome.other};` +
      series.map((c, i) => `--s${i + 1}:${c};`).join("") + heat.map((c, i) => `--h${i}:${c};`).join("");
  };

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>GCP Daily Cost</title>
<style>
:root{${vars("light")}}
@media (prefers-color-scheme: dark){:root:where(:not([data-theme="light"])){${vars("dark")}}}
:root[data-theme="dark"]{${vars("dark")}}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:0 0 12px}
.sub,.muted{color:var(--ink2)}.note{color:var(--muted);font-size:12px;margin-top:8px}
.tiles{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0 24px}
.tile{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 16px;min-width:150px}
.tile .k{color:var(--ink2);font-size:12px}.tile .v{font-size:22px;font-weight:600}
section{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:20px}
svg{width:100%;height:auto;display:block}
.grid{stroke:var(--grid);stroke-width:1}.axis{stroke:var(--axis);stroke-width:1}
.tick{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
${Array.from({ length: SLOTS }, (_, i) => `.s${i + 1}{fill:var(--s${i + 1});background:var(--s${i + 1})}`).join("")}.s0{fill:var(--other);background:var(--other)}
.partial{opacity:.5}
svg [data-tip]:hover{opacity:.8}
ul.legend{list-style:none;padding:0;margin:8px 0 12px;display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12px}
.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.scroll{overflow-x:auto}
table{border-collapse:separate;border-spacing:0;font-size:12px;font-variant-numeric:tabular-nums;width:100%}
th,td{padding:4px 8px;text-align:right;white-space:nowrap;border-bottom:1px solid var(--grid)}
th:first-child,td:first-child{text-align:left;position:sticky;left:0;background:var(--surface)}
th{color:var(--ink2);font-weight:600}
${Array.from({ length: 6 }, (_, i) => `td.h${i}{background:var(--h${i});color:var(--heat-ink)}`).join("")}
td.tot{font-weight:600}tr.foot td{font-weight:600;border-top:1px solid var(--axis)}
#tip{position:fixed;pointer-events:none;background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:6px;padding:6px 8px;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,.15);display:none;max-width:360px}
</style></head><body><main>
<h1>GCP Daily Cost</h1>
<div class="sub">Cloud Run and Compute Engine, net of credits · ${start} to ${end} (${TZ})</div>
<div class="tiles">${tiles}</div>
${sections.map(s => `<section><h2>${esc(s.project)} <span class="muted">· ${usd(s.total)}</span></h2>
${s.mine.length ? `<ul class="legend">${legend(s)}</ul>${chart(s)}${table(s)}` : `<p class="muted">No Cloud Run or Compute Engine cost in this range.</p>`}
</section>`).join("\n")}
<p class="note">${lastDay ? `The billing export has usage through ${lastDay}; days marked * are partial and drawn faded.` : "The billing export has no usage yet."} Compute Engine rows are labelled [vm], [disk] or [other]; Cloud Run rows are the service name. Generated ${new Date().toISOString()} by packages/console/scripts/gcp-daily-cost.ts.</p>
</main><div id="tip"></div>
<script>
const tip=document.getElementById("tip");
document.addEventListener("mousemove",e=>{const t=e.target.closest&&e.target.closest("[data-tip]");if(!t){tip.style.display="none";return}
tip.textContent=t.getAttribute("data-tip");tip.style.display="block";
const x=Math.min(e.clientX+12,innerWidth-tip.offsetWidth-8),y=e.clientY+14+tip.offsetHeight>innerHeight?e.clientY-tip.offsetHeight-10:e.clientY+14;
tip.style.left=x+"px";tip.style.top=y+"px"});
</script>
</body></html>
`;
}
