#!/usr/bin/env node
/**
 * Item lifecycle report — one row per create_item ATTEMPT, start to finish.
 *
 * The funnel report answers "how many". This answers "what happened to the thing
 * that got made": which language, did the create succeed, what id came back, how
 * many times it was revised, whether anyone opened it, and whether it was claimed
 * into an account.
 *
 * Attempts, not items: a create that failed has no item id and is exactly the row
 * you most want to see, so it appears with its error rather than being dropped.
 *
 * Sources, all Cloud Logging (no Firestore — the free-plan TTL is 48h, so items
 * vanish from the database long before they leave the logs):
 *   mcp-service  mcp_tool           create/update/render/get/spec, joined on `item`
 *   app          artifact_view      the render-host page was opened
 *   console      claim              which source ids moved, under which claim_id
 *
 * The joins are only as old as the instrumentation: `item` on mcp_tool and
 * `claim_id`/`items` on the claim event both ship 2026-08-25. Rows before that
 * show "—" for the columns that need them, which is missing data, not a zero.
 *
 * Usage:
 *   npx tsx scripts/mcp-item-lifecycle.ts [--days 7] [--lang L0166]
 *                                         [--failed-only] [--output <file.html>]
 *
 * Auth: gcloud auth login   (shells out to `gcloud logging read`)
 */

import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';

const PROJECT = 'graffiticode-app';

// --- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
function arg(name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}
const DAYS = Number(arg('days', '7'));
const LANG_FILTER = arg('lang');
const FAILED_ONLY = argv.includes('--failed-only');
const OUTPUT = arg('output');

const END = new Date();
const START = new Date(END.getTime() - DAYS * 864e5);

// --- chunked log reads ------------------------------------------------------
// Cloud Logging 500s on any scan wider than ~a week regardless of filter
// selectivity, so slice the window. Same constraint (and same remedy) as
// mcp-funnel-report.ts — a failed slice must never read as an empty result.
const LOG_CHUNK_DAYS = 3;

function readLogSlice(filter: string): any[] | null {
  try {
    const raw = execFileSync('gcloud', [
      'logging', 'read', filter,
      '--project', PROJECT,
      '--format', 'json',
      '--limit', '50000',
    ], { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readLogChunked(baseFilter: string, label: string): any[] {
  const out: any[] = [];
  const step = LOG_CHUNK_DAYS * 864e5;
  let slices = 0, failed = 0;
  for (let t = START.getTime(); t < END.getTime(); t += step) {
    const a = new Date(t);
    const b = new Date(Math.min(t + step, END.getTime()));
    const range = (x: Date, y: Date) =>
      `${baseFilter} AND timestamp>="${x.toISOString()}" AND timestamp<"${y.toISOString()}"`;
    slices++;
    let res = readLogSlice(range(a, b));
    if (res === null) {
      const mid = new Date((a.getTime() + b.getTime()) / 2);
      const l = readLogSlice(range(a, mid));
      const r = readLogSlice(range(mid, b));
      if (l === null || r === null) { failed++; continue; }
      res = [...l, ...r];
    }
    out.push(...res);
  }
  if (failed) {
    console.warn(`WARN: ${failed}/${slices} log slice(s) failed for ${label} — UNDER-COUNTED, not empty.`);
  }
  return out;
}

// --- event shapes -----------------------------------------------------------
interface ToolEvent {
  ev: 'mcp_tool';
  t: string;
  tool: string;
  outcome: string;
  ms: number;
  lang?: string;
  item?: string;
  session: string;
  auth: 'freePlan' | 'firebase';
  client_kind?: string;
  err?: string;
}
interface ClaimEvent {
  ev: 'claim';
  t: string;
  outcome: 'ok' | 'error';
  session: string;
  claim_id?: string;
  transferred?: number;
  items?: { from: string; to: string }[];
}
interface ArtifactViewEvent { ev: 'artifact_view'; t: string; item: string; allowed?: boolean }

function payloads<T>(rows: any[], ev: string): T[] {
  return rows.map(r => r.jsonPayload).filter((p: any) => p && p.ev === ev) as T[];
}

// --- assemble ---------------------------------------------------------------
interface Lifecycle {
  t: string;
  lang: string;
  outcome: string;
  ok: boolean;
  item?: string;
  session: string;
  auth: string;
  client: string;
  createMs: number;
  err?: string;
  updates: number;
  updateFailures: number;
  renders: number;
  views: number;
  claimId?: string;
  claimedTo?: string;
}

function build(): { rows: Lifecycle[]; orphanUpdates: number } {
  console.log(`Reading MCP tool events (${START.toISOString().slice(0, 10)} → ${END.toISOString().slice(0, 10)})...`);
  const tools = payloads<ToolEvent>(
    readLogChunked('resource.labels.service_name="mcp-service" AND jsonPayload.ev="mcp_tool"', 'mcp_tool'),
    'mcp_tool',
  );
  console.log('Reading artifact views...');
  const views = payloads<ArtifactViewEvent>(
    readLogChunked('resource.labels.service_name="app" AND jsonPayload.ev="artifact_view"', 'artifact_view'),
    'artifact_view',
  );
  console.log('Reading claims...');
  const claims = payloads<ClaimEvent>(
    readLogChunked('resource.labels.service_name="console" AND jsonPayload.ev="claim"', 'claim'),
    'claim',
  );

  // item id → the claim that moved it
  const claimByItem = new Map<string, { claimId?: string; to: string }>();
  for (const c of claims) {
    if (c.outcome !== 'ok') continue;
    for (const pair of c.items ?? []) {
      claimByItem.set(pair.from, { claimId: c.claim_id, to: pair.to });
    }
  }

  const viewsByItem = new Map<string, number>();
  for (const v of views) {
    if (v.allowed === false) continue;
    viewsByItem.set(v.item, (viewsByItem.get(v.item) ?? 0) + 1);
  }

  const updatesByItem = new Map<string, { ok: number; failed: number }>();
  const rendersByItem = new Map<string, number>();
  let orphanUpdates = 0;
  for (const e of tools) {
    if (!e.item || e.item === '(invalid)') {
      if (e.tool === 'update_item') orphanUpdates++;
      continue;
    }
    if (e.tool === 'update_item') {
      const cur = updatesByItem.get(e.item) ?? { ok: 0, failed: 0 };
      if (e.outcome === 'ok') cur.ok++; else cur.failed++;
      updatesByItem.set(e.item, cur);
    } else if (e.tool === 'render_item' || e.tool === 'get_item') {
      rendersByItem.set(e.item, (rendersByItem.get(e.item) ?? 0) + 1);
    }
  }

  const rows: Lifecycle[] = tools
    .filter(e => e.tool === 'create_item')
    .map(e => {
      const item = e.item && e.item !== '(invalid)' ? e.item : undefined;
      const upd = item ? updatesByItem.get(item) : undefined;
      const claim = item ? claimByItem.get(item) : undefined;
      return {
        t: e.t,
        lang: e.lang ?? '—',
        outcome: e.outcome,
        ok: e.outcome === 'ok',
        item,
        session: e.session,
        auth: e.auth,
        client: e.client_kind ?? '—',
        createMs: e.ms,
        err: e.err,
        updates: upd?.ok ?? 0,
        updateFailures: upd?.failed ?? 0,
        renders: item ? rendersByItem.get(item) ?? 0 : 0,
        views: item ? viewsByItem.get(item) ?? 0 : 0,
        claimId: claim?.claimId,
        claimedTo: claim?.to,
      };
    })
    .filter(r => (LANG_FILTER ? r.lang === LANG_FILTER.toUpperCase() : true))
    .filter(r => (FAILED_ONLY ? !r.ok : true))
    .sort((a, b) => b.t.localeCompare(a.t));

  return { rows, orphanUpdates };
}

// --- render -----------------------------------------------------------------
const { rows, orphanUpdates } = build();

const created = rows.filter(r => r.ok).length;
const failed = rows.length - created;
const revised = rows.filter(r => r.updates > 0).length;
const viewed = rows.filter(r => r.views > 0).length;
const claimed = rows.filter(r => r.claimId).length;
const unknownItem = rows.filter(r => r.ok && !r.item).length;

console.log(`\n=== create_item lifecycle — last ${DAYS}d${LANG_FILTER ? ` · ${LANG_FILTER}` : ''} ===`);
console.log(`Attempts        : ${rows.length}  (ok ${created}, failed ${failed})`);
console.log(`Revised (≥1 upd): ${revised}`);
console.log(`Opened (artifact view): ${viewed}`);
console.log(`Claimed         : ${claimed}`);
if (unknownItem) {
  console.log(`No item id      : ${unknownItem} — created BEFORE the \`item\` field shipped (2026-08-25); their updates/views/claims cannot be joined.`);
}
if (orphanUpdates) {
  console.log(`Orphan updates  : ${orphanUpdates} update call(s) with no usable item id (pre-instrumentation or malformed arg).`);
}
console.log('');

const head = ['when', 'lang', 'result', 'item', 'upd', 'rnd', 'view', 'claim', 'client', 'auth'];
const widths = [16, 6, 8, 20, 4, 4, 5, 10, 18, 8];
console.log(head.map((h, i) => h.padEnd(widths[i])).join(' '));
console.log(widths.map(w => '-'.repeat(w)).join(' '));
for (const r of rows) {
  const cells = [
    r.t.slice(5, 16).replace('T', ' '),
    r.lang,
    r.ok ? 'ok' : r.outcome === 'generation_failed' ? 'gen-fail' : 'error',
    r.item ?? '—',
    String(r.updates + (r.updateFailures ? `+${r.updateFailures}!` : '')),
    String(r.renders),
    String(r.views),
    r.claimId ? r.claimId.slice(0, 8) : '—',
    r.client.slice(0, 18),
    r.auth,
  ];
  console.log(cells.map((c, i) => String(c).padEnd(widths[i])).join(' '));
  if (r.err) console.log(`${' '.repeat(4)}↳ ${r.err.slice(0, 160)}`);
}

if (OUTPUT) {
  const esc = (v: unknown) => String(v ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
  const html = `<!doctype html><meta charset="utf-8"><title>Item lifecycle — last ${DAYS}d</title>
<style>
 body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:2rem;color:#111}
 table{border-collapse:collapse;width:100%;font-size:13px}
 th,td{border-bottom:1px solid #e5e5e5;padding:6px 8px;text-align:left;vertical-align:top}
 th{background:#fafafa;font-weight:600}
 code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
 .fail{color:#b00}.ok{color:#070}.dim{color:#999}
 .sum{margin:0 0 1rem;padding:.75rem 1rem;background:#fafafa;border:1px solid #eee}
</style>
<h1>create_item lifecycle — last ${DAYS} days${LANG_FILTER ? ` · ${esc(LANG_FILTER)}` : ''}</h1>
<div class="sum">
 <b>${rows.length}</b> attempts — ${created} ok, ${failed} failed ·
 <b>${revised}</b> revised · <b>${viewed}</b> opened · <b>${claimed}</b> claimed
 ${unknownItem ? `<br><span class="dim">${unknownItem} row(s) predate the <code>item</code> field (2026-08-25); their joins are unavailable, not zero.</span>` : ''}
</div>
<table><thead><tr>${['when', 'lang', 'result', 'item', 'updates', 'renders', 'views', 'claim', 'client', 'auth', 'error']
    .map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>
${rows.map(r => `<tr>
 <td>${esc(r.t.slice(0, 16).replace('T', ' '))}</td>
 <td>${esc(r.lang)}</td>
 <td class="${r.ok ? 'ok' : 'fail'}">${esc(r.ok ? 'ok' : r.outcome)}</td>
 <td><code>${esc(r.item ?? '—')}</code></td>
 <td>${r.updates}${r.updateFailures ? ` <span class="fail">+${r.updateFailures} failed</span>` : ''}</td>
 <td>${r.renders}</td>
 <td>${r.views}</td>
 <td>${r.claimId ? `<code>${esc(r.claimId.slice(0, 8))}</code> → <code>${esc(r.claimedTo ?? '')}</code>` : '—'}</td>
 <td>${esc(r.client)}</td>
 <td>${esc(r.auth)}</td>
 <td class="fail">${esc(r.err ?? '')}</td>
</tr>`).join('\n')}
</tbody></table>`;
  writeFileSync(OUTPUT, html);
  console.log(`\nWrote ${OUTPUT}`);
}
