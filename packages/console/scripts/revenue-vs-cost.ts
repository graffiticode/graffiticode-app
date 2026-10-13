#!/usr/bin/env node

import admin from 'firebase-admin';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { estimateUsdCost, usdCostFromReport } from '../src/lib/model-pricing';

// Load .env.local
const envPath = resolve(process.cwd(), '.env.local');
try {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
  }
} catch {};

// Force connection to production Firestore (bypass emulator)
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

// Use GRAFFITICODE_APP_CREDENTIALS for the graffiticode-app project
if (process.env.GRAFFITICODE_APP_CREDENTIALS) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GRAFFITICODE_APP_CREDENTIALS;
} else {
  console.error('Error: GRAFFITICODE_APP_CREDENTIALS environment variable not set');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "graffiticode-app"
});
const db = admin.firestore();


function parseArgs(argv: string[]): { period: string; output: string; lang?: string; from?: string; to?: string; tz?: string; group: 'day' | 'week'; avg: boolean } {
  const args = argv.slice(2);
  let period = 'all';
  let output = 'revenue-vs-cost.html';
  let lang: string | undefined;
  let from: string | undefined;
  let to: string | undefined;
  let tz: string | undefined;
  let group: 'day' | 'week' = 'day';
  let avg = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--period' && args[i + 1]) { period = args[i + 1]; i++; }
    else if (args[i] === '--output' && args[i + 1]) { output = args[i + 1]; i++; }
    else if (args[i] === '--lang' && args[i + 1]) { lang = args[i + 1]; i++; }
    else if (args[i] === '--from' && args[i + 1]) { from = args[i + 1]; i++; }
    else if (args[i] === '--to' && args[i + 1]) { to = args[i + 1]; i++; }
    else if (args[i] === '--tz' && args[i + 1]) { tz = args[i + 1]; i++; }
    else if (args[i] === '--group' && args[i + 1]) {
      const g = args[i + 1];
      if (g !== 'day' && g !== 'week') {
        console.error('Error: --group must be "day" or "week"');
        process.exit(1);
      }
      group = g;
      i++;
    }
    else if (args[i] === '--avg') { avg = true; }
  }
  if (from) {
    period = 'custom';
  } else if (!['all', 'month', 'week', 'day'].includes(period)) {
    console.error('Error: --period must be "all", "month", "week", or "day", or use --from/--to YYYY-MM-DD');
    process.exit(1);
  }
  return { period, output, lang, from, to, tz, group, avg };
}

function groupBucketsByWeek(buckets: DailyBucket[], avg: boolean): DailyBucket[] {
  if (buckets.length === 0) return [];
  const sorted = [...buckets].sort((a, b) => a.date.localeCompare(b.date));
  const result: DailyBucket[] = [];
  for (let i = 0; i < sorted.length; i += 7) {
    const chunk = sorted.slice(i, i + 7);
    const n = chunk.length;
    const start = chunk[0].date;
    const end = chunk[n - 1].date;
    const agg: DailyBucket = {
      date: start === end ? start : `${start}…${end}`,
      projectedRevenue: 0, projectedCost: 0, estimatedCost: 0,
      units: 0, actualInputTokens: 0, actualOutputTokens: 0,
      actualCachedInputTokens: 0, actualUncachedInputTokens: 0,
    };
    for (const b of chunk) {
      agg.projectedRevenue += b.projectedRevenue;
      agg.projectedCost += b.projectedCost;
      agg.estimatedCost += b.estimatedCost;
      agg.units += b.units;
      agg.actualInputTokens += b.actualInputTokens;
      agg.actualOutputTokens += b.actualOutputTokens;
      agg.actualCachedInputTokens += b.actualCachedInputTokens;
      agg.actualUncachedInputTokens += b.actualUncachedInputTokens;
    }
    if (avg) {
      agg.projectedRevenue /= n;
      agg.projectedCost /= n;
      agg.estimatedCost /= n;
      agg.units /= n;
      agg.actualInputTokens = Math.round(agg.actualInputTokens / n);
      agg.actualOutputTokens = Math.round(agg.actualOutputTokens / n);
      agg.actualCachedInputTokens = Math.round(agg.actualCachedInputTokens / n);
      agg.actualUncachedInputTokens = Math.round(agg.actualUncachedInputTokens / n);
    }
    result.push(agg);
  }
  return result;
}

// Convert a UTC ms timestamp to a YYYY-MM-DD string in the given timezone
function msToDateStr(ms: number, tz?: string): string {
  if (!tz) return new Date(ms).toISOString().split('T')[0];
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: tz }); // en-CA gives YYYY-MM-DD
}

// Get "today" as YYYY-MM-DD in the given timezone
function getToday(tz?: string): string {
  if (!tz) return new Date().toISOString().split('T')[0];
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

function getPeriodStart(period: string, from?: string, tz?: string): Date | null {
  if (period === 'all') return null;
  if (period === 'custom' && from) return new Date(from + 'T00:00:00Z');
  const todayStr = getToday(tz);
  const today = new Date(todayStr + 'T00:00:00Z');
  if (period === 'day') return today;
  if (period === 'week') return new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (period === 'month') return new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  return null;
}

function getPeriodEnd(to?: string, tz?: string): string {
  if (to) return new Date(new Date(to + 'T00:00:00Z').getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  return getToday(tz);
}

function getTimestampMs(r: UsageRecord): number | null {
  if (r.createdAt) {
    const ts = r.createdAt as any;
    if (typeof ts === 'number') return ts;
    if (typeof ts.toMillis === 'function') return ts.toMillis();
    if (ts._seconds != null) return ts._seconds * 1000;
    if (ts.seconds != null) return ts.seconds * 1000;
  }
  if (r.timestamp) return new Date(r.timestamp).getTime();
  return null;
}

interface UsageRecord {
  userId: string;
  type: string;
  units: number;
  model?: string;
  tokens?: { input: number; output: number; total: number };
  plan?: string;
  lang?: string;
  createdAt?: admin.firestore.Timestamp;
  timestamp?: string;
  wasOverLimit?: boolean;
}

interface DailyBucket {
  date: string;
  projectedRevenue: number;
  projectedCost: number;
  estimatedCost: number;
  units: number;
  actualInputTokens: number;
  actualOutputTokens: number;
  actualCachedInputTokens: number;
  actualUncachedInputTokens: number;
}

// NOTE: This report predates item-based pricing and its revenue figures are NO
// LONGER VALID. Under item pricing, revenue = flat base fee + (overage items ×
// per-item rate), and the metered unit is `type: 'item_created'` (units: 1);
// ai_generation/compile records now carry units: 0. Rework this report to model
// base + included + overage before trusting its revenue numbers. The per-unit
// map below reflects the OLD compile-unit revenue and is kept only so the
// script still runs.
const PLAN_PRICE_PER_UNIT: Record<string, number> = {
  free: 0, pro: 100 / 100000, teams: 1000 / 2000000,
};

// Legacy plan names are folded into current ones for attribution.
const PLAN_ALIASES: Record<string, string> = { demo: 'free', starter: 'pro' };
const normalizePlan = (plan?: string): string => {
  const p = plan || 'free';
  return PLAN_ALIASES[p] || p;
};

// Actual daily data loaded from data/daily-usage/ files (populated by fetch-daily-usage.ts)
interface ActualDailyData {
  date: string;
  estimatedCost: number; // USD computed from usage tokens × pricing
  usage: {
    uncached_input_tokens: number;
    cached_input_tokens: number;
    cache_creation_input_tokens: number;
    output_tokens: number;
  } | null;
  usageByModel: Record<string, { input: number; cached_input: number; cache_creation: number; output: number }>;
}

function ensureYesterdayData(): void {
  const now = new Date();
  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const dateStr = yesterday.toISOString().split('T')[0];

  const usageDir = resolve(process.cwd(), 'data', 'daily-usage');
  const usageFile = resolve(usageDir, `usage-${dateStr}.json`);

  if (!existsSync(usageFile)) {
    console.log(`  Missing usage for ${dateStr}, fetch with: npx tsx scripts/fetch-daily-usage.ts`);
  }
}

function loadDailyData(startDate: string | null, endDate: string): ActualDailyData[] {
  const usageDir = resolve(process.cwd(), 'data', 'daily-usage');
  const results: ActualDailyData[] = [];

  const usageFiles = existsSync(usageDir)
    ? readdirSync(usageDir).filter(f => f.startsWith('usage-') && f.endsWith('.json'))
    : [];

  const dates = usageFiles
    .map(f => f.replace('usage-', '').replace('.json', ''))
    .filter(date => (!startDate || date >= startDate) && date <= endDate)
    .sort();

  for (const date of dates) {
    const entry: ActualDailyData = { date, estimatedCost: 0, usage: null, usageByModel: {} };

    const usageFile = resolve(usageDir, `usage-${date}.json`);
    try {
      const data = JSON.parse(readFileSync(usageFile, 'utf-8'));
      if (data.totals) {
        entry.usage = {
          uncached_input_tokens: data.totals.uncached_input_tokens || 0,
          cached_input_tokens: data.totals.cached_input_tokens || 0,
          output_tokens: data.totals.output_tokens || 0,
        };
      }
      if (data.by_model) {
        for (const [model, stats] of Object.entries(data.by_model as Record<string, any>)) {
          entry.usageByModel[model] = {
            input: stats.input || 0,
            cached_input: stats.cached_input || 0,
            cache_creation: stats.cache_creation || 0,
            output: stats.output || 0,
          };
          entry.estimatedCost += usdCostFromReport({
            uncachedInput: stats.input || 0,
            cacheRead: stats.cached_input || 0,
            cacheWrite5m: stats.cache_creation || 0,
            output: stats.output || 0,
          }, model);
        }
      }
    } catch {}

    results.push(entry);
  }

  return results;
}

function generateHtml(data: {
  period: string;
  lang?: string;
  periodStart: Date | null;
  aiRecords: UsageRecord[];
  compileRecords: UsageRecord[];
  totalProjectedCost: number;
  totalEstimatedCost: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  costByModel: Record<string, { calls: number; input: number; output: number; cost: number }>;
  actualCostByModel: Record<string, number>;
  actualUsageByModel: Record<string, { input: number; cached_input: number; output: number }>;
  totalActualInputTokens: number;
  totalActualOutputTokens: number;
  totalActualCachedInputTokens: number;
  totalActualUncachedInputTokens: number;
  hasActualUsage: boolean;
  totalAiUnits: number;
  totalCompileUnits: number;
  cappedRequests: number;
  unitsByPlan: Record<string, number>;
  totalProjectedRevenue: number;
  dailyBuckets: DailyBucket[];
}): string {
  const now = new Date().toISOString();
  const periodLabel = data.periodStart
    ? `${data.period} (since ${data.periodStart.toISOString().split('T')[0]})`
    : 'all time';
  const langLabel = data.lang ? ` | Language: L${data.lang}` : '';
  const estimatedCostValue = data.totalEstimatedCost != null ? `$${data.totalEstimatedCost.toFixed(2)}` : '—';
  const cost = data.totalEstimatedCost ?? data.totalProjectedCost;
  const margin = data.totalProjectedRevenue - cost;
  const marginPct = data.totalProjectedRevenue > 0 ? ((1 - cost / data.totalProjectedRevenue) * 100).toFixed(1) : '—';
  const avgCostPerCall = data.aiRecords.length > 0 ? (data.totalProjectedCost / data.aiRecords.length).toFixed(4) : '—';
  const avgCostPerUnit = data.totalAiUnits > 0 ? (data.totalProjectedCost / data.totalAiUnits).toFixed(4) : '—';
  const totalUnits = data.totalAiUnits + data.totalCompileUnits;

  // Model table rows (projected)
  const modelRows = Object.entries(data.costByModel)
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(([model, s]) => `<tr><td>${model}</td><td>${s.calls.toLocaleString()}</td><td>${s.input.toLocaleString()}</td><td>${s.output.toLocaleString()}</td><td>$${s.cost.toFixed(2)}</td></tr>`)
    .join('\n');

  // Actual cost by model rows
  const actualCostModelRows = Object.entries(data.actualCostByModel)
    .sort((a, b) => b[1] - a[1])
    .map(([model, cost]) => `<tr><td>${model}</td><td>$${cost.toFixed(4)}</td></tr>`)
    .join('\n');

  // Actual usage by model rows
  const actualUsageModelRows = Object.entries(data.actualUsageByModel)
    .sort((a, b) => (b[1].input + b[1].output) - (a[1].input + a[1].output))
    .map(([model, s]) => {
      const total = s.input + s.cached_input + s.output;
      return `<tr><td>${model}</td><td>${s.input.toLocaleString()}</td><td>${s.cached_input.toLocaleString()}</td><td>${s.output.toLocaleString()}</td><td>${total.toLocaleString()}</td></tr>`;
    })
    .join('\n');


  // Plan table rows
  const planRows = Object.entries(data.unitsByPlan)
    .sort((a, b) => b[1] - a[1])
    .map(([plan, units]) => {
      const value = units * (PLAN_PRICE_PER_UNIT[plan] || 0);
      return `<tr><td>${plan}</td><td>${units.toLocaleString()}</td><td>$${value.toFixed(2)}</td></tr>`;
    })
    .join('\n');

  // Chart data
  const chartLabels = JSON.stringify(data.dailyBuckets.map(b => b.date));
  const chartProjectedRevenue = JSON.stringify(data.dailyBuckets.map(b => +b.projectedRevenue.toFixed(2)));
  const chartProjectedCost = JSON.stringify(data.dailyBuckets.map(b => +b.projectedCost.toFixed(2)));

  const chartActualInput = JSON.stringify(data.dailyBuckets.map(b => b.actualInputTokens));
  const chartActualOutput = JSON.stringify(data.dailyBuckets.map(b => b.actualOutputTokens));
  const chartCacheHitRatio = JSON.stringify(data.dailyBuckets.map(b => {
    const denom = b.actualCachedInputTokens + b.actualUncachedInputTokens;
    return denom > 0 ? +((b.actualCachedInputTokens / denom) * 100).toFixed(1) : null;
  }));

  const totalCacheDenom = data.totalActualCachedInputTokens + data.totalActualUncachedInputTokens;
  const overallCacheHitPct = totalCacheDenom > 0
    ? ((data.totalActualCachedInputTokens / totalCacheDenom) * 100).toFixed(1)
    : null;

  const chartEstimatedCost = JSON.stringify(data.dailyBuckets.map(b => +b.estimatedCost.toFixed(2)));
  const hasEstimatedCost = data.totalEstimatedCost != null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Revenue vs Cost Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; color: #1e293b; padding: 24px; max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin-bottom: 4px; }
  .subtitle { color: #64748b; font-size: 0.875rem; margin-bottom: 24px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .card { background: #fff; border-radius: 8px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .card .label { font-size: 0.75rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
  .card .value { font-size: 1.5rem; font-weight: 600; margin-top: 4px; }
  .card .sub { font-size: 0.75rem; color: #94a3b8; margin-top: 2px; }
  .card .value.positive { color: #16a34a; }
  .card .value.negative { color: #dc2626; }
  .card .value.cost { color: #dc2626; }
  .card .value.revenue { color: #16a34a; }
  .section { margin-bottom: 32px; }
  .section h2 { font-size: 1.1rem; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); font-size: 0.85rem; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #e2e8f0; }
  th { background: #f1f5f9; font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #475569; }
  td:last-child, th:last-child { text-align: right; }
  .chart-container { background: #fff; border-radius: 8px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 32px; }
  .chart-container canvas { max-height: 300px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  @media (max-width: 768px) { .grid-2 { grid-template-columns: 1fr; } }
  code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 0.8rem; }
</style>
</head>
<body>
<h1>Revenue vs Cost Report</h1>
<p class="subtitle">Period: ${periodLabel}${langLabel} | Generated: ${now}</p>

<div class="cards">
  <div class="card"><div class="label">Revenue</div><div class="value revenue">$${data.totalProjectedRevenue.toFixed(2)}</div><div class="sub">Units x plan price</div></div>
  <div class="card"><div class="label">Cost</div><div class="value cost">${estimatedCostValue}</div><div class="sub">Tokens x pricing</div></div>
  <div class="card"><div class="label">Margin</div><div class="value ${margin >= 0 ? 'positive' : 'negative'}">$${margin.toFixed(2)}</div><div class="sub">${marginPct}%</div></div>
  <div class="card"><div class="label">Total Units</div><div class="value">${totalUnits.toLocaleString()}</div></div>
  ${overallCacheHitPct != null ? `<div class="card"><div class="label">Cache Hit Ratio</div><div class="value">${overallCacheHitPct}%</div><div class="sub">Cached / total input tokens</div></div>` : ''}
</div>

<div class="chart-container">
  <h2 style="margin-bottom:12px">Revenue vs Cost Over Time</h2>
  <canvas id="revenueChart"></canvas>
</div>


<div class="section">
  <h2>Cost Summary</h2>
  <table>
    <thead><tr><th>Metric</th><th>Revenue</th><th>Cost</th><th>Margin</th></tr></thead>
    <tbody>
      <tr>
        <td>Total</td>
        <td>$${data.totalProjectedRevenue.toFixed(2)}</td>
        <td>${estimatedCostValue}</td>
        <td>$${margin.toFixed(2)}</td>
      </tr>
      <tr>
        <td>Margin %</td>
        <td></td>
        <td></td>
        <td>${marginPct}%</td>
      </tr>
    </tbody>
  </table>
</div>

<div class="section">
  <h2>Units by Plan</h2>
  <table>
    <thead><tr><th>Plan</th><th>Units</th><th>Value</th></tr></thead>
    <tbody>${planRows}
      <tr style="font-weight:600"><td>Total</td><td>${totalUnits.toLocaleString()}</td><td></td></tr>
    </tbody>
  </table>
</div>

<div class="section">
  <h2>Projected Cost by Model</h2>
  <table>
    <thead><tr><th>Model</th><th>Calls</th><th>Input Tokens</th><th>Output Tokens</th><th>Cost</th></tr></thead>
    <tbody>${modelRows}
      <tr style="font-weight:600"><td>Total</td><td>${data.aiRecords.length.toLocaleString()}</td><td>${data.totalInputTokens.toLocaleString()}</td><td>${data.totalOutputTokens.toLocaleString()}</td><td>$${data.totalProjectedCost.toFixed(2)}</td></tr>
    </tbody>
  </table>
</div>

${hasEstimatedCost ? `
<div class="grid-2">
  <div class="section">
    <h2>Usage Cost by Model</h2>
    <table>
      <thead><tr><th>Model</th><th>Cost</th></tr></thead>
      <tbody>${actualCostModelRows}
        <tr style="font-weight:600"><td>Total</td><td>${estimatedCostValue}</td></tr>
      </tbody>
    </table>
  </div>
  ${data.hasActualUsage ? `
  <div class="section">
    <h2>Actual Usage by Model</h2>
    <table>
      <thead><tr><th>Model</th><th>Input</th><th>Cached</th><th>Output</th><th>Total</th></tr></thead>
      <tbody>${actualUsageModelRows}
        <tr style="font-weight:600"><td>Total</td><td>${data.totalActualInputTokens.toLocaleString()}</td><td></td><td>${data.totalActualOutputTokens.toLocaleString()}</td><td>${(data.totalActualInputTokens + data.totalActualOutputTokens).toLocaleString()}</td></tr>
      </tbody>
    </table>
  </div>` : ''}
</div>` : ''}

${data.hasActualUsage ? `
<div class="chart-container">
  <h2 style="margin-bottom:12px">Actual Token Usage Over Time</h2>
  <canvas id="tokenChart"></canvas>
</div>` : ''}

<div class="section">
  <h2>Token Usage</h2>
  <table>
    <thead><tr><th>Metric</th><th>Projected</th>${data.hasActualUsage ? '<th>Actual</th>' : ''}</tr></thead>
    <tbody>
      <tr><td>Input tokens</td><td>${data.totalInputTokens.toLocaleString()}</td>${data.hasActualUsage ? `<td>${data.totalActualInputTokens.toLocaleString()}</td>` : ''}</tr>
      ${data.hasActualUsage ? `<tr><td>&nbsp;&nbsp;Uncached</td><td></td><td>${data.totalActualUncachedInputTokens.toLocaleString()}</td></tr>
      <tr><td>&nbsp;&nbsp;Cached</td><td></td><td>${data.totalActualCachedInputTokens.toLocaleString()}</td></tr>
      <tr><td>&nbsp;&nbsp;Cache hit ratio</td><td></td><td>${overallCacheHitPct != null ? overallCacheHitPct + '%' : '—'}</td></tr>` : ''}
      <tr><td>Output tokens</td><td>${data.totalOutputTokens.toLocaleString()}</td>${data.hasActualUsage ? `<td>${data.totalActualOutputTokens.toLocaleString()}</td>` : ''}</tr>
      <tr><td>Total tokens</td><td>${(data.totalInputTokens + data.totalOutputTokens).toLocaleString()}</td>${data.hasActualUsage ? `<td>${(data.totalActualInputTokens + data.totalActualOutputTokens).toLocaleString()}</td>` : ''}</tr>
      <tr><td>AI generation units</td><td>${data.totalAiUnits.toLocaleString()}</td>${data.hasActualUsage ? '<td></td>' : ''}</tr>
      <tr><td>Plain compile units</td><td>${data.totalCompileUnits.toLocaleString()}</td>${data.hasActualUsage ? '<td></td>' : ''}</tr>
      <tr><td>Requests at 20-unit cap</td><td>${data.cappedRequests.toLocaleString()} of ${data.aiRecords.length.toLocaleString()}</td>${data.hasActualUsage ? '<td></td>' : ''}</tr>
    </tbody>
  </table>
</div>

<script>
const labels = ${chartLabels};
const projectedRevenueData = ${chartProjectedRevenue};
const projectedCostData = ${chartProjectedCost};
const estimatedCostData = ${chartEstimatedCost};

const actualInputData = ${chartActualInput};
const actualOutputData = ${chartActualOutput};
const cacheHitRatioData = ${chartCacheHitRatio};

new Chart(document.getElementById('revenueChart'), {
  type: 'bar',
  data: {
    labels,
    datasets: [
      { label: 'Revenue', data: projectedRevenueData, backgroundColor: 'rgba(22,163,74,0.7)', borderRadius: 4 },
      ${hasEstimatedCost ? `{ label: 'Cost', data: estimatedCostData, backgroundColor: 'rgba(220,38,38,0.5)', borderRadius: 4 },` : ''}
    ]
  },
  options: {
    responsive: true,
    plugins: { legend: { position: 'top' } },
    scales: {
      y: { beginAtZero: true, ticks: { callback: v => '$' + v } }
    }
  }
});


if (document.getElementById('tokenChart')) {
  new Chart(document.getElementById('tokenChart'), {
    data: {
      labels,
      datasets: [
        { type: 'bar', label: 'Input Tokens', data: actualInputData, backgroundColor: 'rgba(59,130,246,0.7)', borderRadius: 4, yAxisID: 'y', stack: 'tokens' },
        { type: 'bar', label: 'Output Tokens', data: actualOutputData, backgroundColor: 'rgba(168,85,247,0.7)', borderRadius: 4, yAxisID: 'y', stack: 'tokens' },
        { type: 'line', label: 'Cache Hit %', data: cacheHitRatioData, borderColor: 'rgba(234,88,12,1)', backgroundColor: 'rgba(234,88,12,0.2)', yAxisID: 'y1', tension: 0.2, spanGaps: true, pointRadius: 3 },
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { position: 'top' } },
      scales: {
        x: { stacked: true },
        y: { stacked: true, beginAtZero: true, ticks: { callback: v => v.toLocaleString() } },
        y1: { position: 'right', beginAtZero: true, max: 100, grid: { drawOnChartArea: false }, ticks: { callback: v => v + '%' } }
      }
    }
  });
}
</script>
</body>
</html>`;
}

async function main() {
  const { period, output, lang, from, to, tz, group, avg } = parseArgs(process.argv);
  const periodStart = getPeriodStart(period, from, tz);
  const periodEnd = getPeriodEnd(to, tz);

  console.log(`Fetching data (period: ${period}${from ? `, from: ${from}` : ''}${to ? `, to: ${to}` : ''})...`);

  // Fetch usage records (filter by type, then by date/lang in code to avoid composite index)
  const snapshot = await db.collection('usage')
    .where('type', 'in', ['ai_generation', 'compile']).get();
  const records: UsageRecord[] = [];
  snapshot.forEach(doc => {
    const data = doc.data() as UsageRecord;
    if (lang && data.lang !== lang && data.lang !== `L${lang}`) return;
    const ms = getTimestampMs(data);
    if (!ms) return;
    if (periodStart && ms < periodStart.getTime()) return;
    if (to) {
      const endMs = new Date(periodEnd + 'T00:00:00Z').getTime();
      if (ms >= endMs) return;
    }
    records.push(data);
  });

  const aiRecords = records.filter(r => r.type === 'ai_generation');
  const compileRecords = records.filter(r => r.type === 'compile');

  // Calculate projected Claude API costs from token usage
  let totalProjectedCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const costByModel: Record<string, { calls: number; input: number; output: number; cost: number }> = {};

  for (const r of aiRecords) {
    const model = r.model || 'unknown';
    const cost = estimateUsdCost({
      inputTokens: r.tokens?.input || 0,
      outputTokens: r.tokens?.output || 0,
      cacheCreationInputTokens: r.tokens?.cacheCreation || 0,
      cacheReadInputTokens: r.tokens?.cacheRead || 0,
    }, model);
    const input = (r.tokens?.input || 0) + (r.tokens?.cacheRead || 0) + (r.tokens?.cacheCreation || 0);
    const output = r.tokens?.output || 0;
    totalProjectedCost += cost;
    totalInputTokens += input;
    totalOutputTokens += output;
    if (!costByModel[model]) costByModel[model] = { calls: 0, input: 0, output: 0, cost: 0 };
    costByModel[model].calls++;
    costByModel[model].input += input;
    costByModel[model].output += output;
    costByModel[model].cost += cost;
  }

  const totalAiUnits = aiRecords.reduce((sum, r) => sum + (r.units || 0), 0);
  const totalCompileUnits = compileRecords.reduce((sum, r) => sum + (r.units || 0), 0);
  const cappedRequests = aiRecords.filter(r => (r.units || 0) >= 20).length;

  const unitsByPlan: Record<string, number> = {};
  for (const r of records) {
    const plan = normalizePlan(r.plan);
    unitsByPlan[plan] = (unitsByPlan[plan] || 0) + (r.units || 0);
  }

  // Projected revenue: units x plan price per unit
  let totalProjectedRevenue = 0;
  for (const [plan, units] of Object.entries(unitsByPlan)) {
    totalProjectedRevenue += units * (PLAN_PRICE_PER_UNIT[plan] || 0);
  }

  // Load actual cost/usage data from data/ files
  console.log('Loading actual cost/usage data from data/ files...');
  ensureYesterdayData();

  const startDateStr = periodStart ? periodStart.toISOString().split('T')[0] : null;
  const endDateStr = periodEnd;
  const dailyData = loadDailyData(startDateStr, endDateStr);
  console.log(`  Loaded ${dailyData.length} days of actual data`);

  const hasActualUsage = dailyData.some(d => d.usage != null);
  const hasEstimatedCosts = dailyData.some(d => d.estimatedCost > 0);
  const totalEstimatedCost = hasEstimatedCosts
    ? dailyData.reduce((sum, d) => sum + d.estimatedCost, 0)
    : null;
  const actualCostByModel: Record<string, number> = {};
  const actualUsageByModel: Record<string, { input: number; cached_input: number; cache_creation: number; output: number }> = {};
  let totalActualInputTokens = 0;
  let totalActualOutputTokens = 0;
  let totalActualCachedInputTokens = 0;
  let totalActualUncachedInputTokens = 0;

  for (const d of dailyData) {
    if (d.usage) {
      totalActualInputTokens += d.usage.uncached_input_tokens + d.usage.cached_input_tokens + d.usage.cache_creation_input_tokens;
      totalActualOutputTokens += d.usage.output_tokens;
      totalActualCachedInputTokens += d.usage.cached_input_tokens;
      totalActualUncachedInputTokens += d.usage.uncached_input_tokens;
    }
    for (const [model, stats] of Object.entries(d.usageByModel)) {
      if (!actualUsageByModel[model]) actualUsageByModel[model] = { input: 0, cached_input: 0, cache_creation: 0, output: 0 };
      actualUsageByModel[model].input += stats.input;
      actualUsageByModel[model].cached_input += stats.cached_input;
      actualUsageByModel[model].cache_creation += stats.cache_creation;
      actualUsageByModel[model].output += stats.output;
      actualCostByModel[model] = (actualCostByModel[model] || 0) + usdCostFromReport({
        uncachedInput: stats.input,
        cacheRead: stats.cached_input,
        cacheWrite5m: stats.cache_creation,
        output: stats.output,
      }, model);
    }
  }
  if (totalEstimatedCost != null) {
    console.log(`  Cost (tokens x pricing): $${totalEstimatedCost.toFixed(2)}`);
  }

  // Build daily buckets for charts
  const emptyBucket = (date: string): DailyBucket => ({ date, projectedRevenue: 0, projectedCost: 0, estimatedCost: 0, units: 0, actualInputTokens: 0, actualOutputTokens: 0, actualCachedInputTokens: 0, actualUncachedInputTokens: 0 });
  const dailyMap: Record<string, DailyBucket> = {};
  // Add all records (ai + compile) for projected revenue, excluding today
  for (const r of records) {
    const ms = getTimestampMs(r);
    if (!ms) continue;
    const date = msToDateStr(ms, tz);
    if (!dailyMap[date]) dailyMap[date] = emptyBucket(date);
    const plan = normalizePlan(r.plan);
    dailyMap[date].projectedRevenue += (r.units || 0) * (PLAN_PRICE_PER_UNIT[plan] || 0);
    dailyMap[date].units += r.units || 0;
  }
  for (const r of aiRecords) {
    const ms = getTimestampMs(r);
    if (!ms) continue;
    const date = msToDateStr(ms, tz);
    if (!dailyMap[date]) dailyMap[date] = emptyBucket(date);
    dailyMap[date].projectedCost += estimateUsdCost({
      inputTokens: r.tokens?.input || 0,
      outputTokens: r.tokens?.output || 0,
      cacheCreationInputTokens: r.tokens?.cacheCreation || 0,
      cacheReadInputTokens: r.tokens?.cacheRead || 0,
    }, r.model || 'unknown');
  }
  // Add actual costs and usage to daily buckets
  for (const d of dailyData) {
    if (!dailyMap[d.date]) dailyMap[d.date] = emptyBucket(d.date);
    dailyMap[d.date].estimatedCost = d.estimatedCost;
    if (d.usage) {
      dailyMap[d.date].actualInputTokens = d.usage.uncached_input_tokens + d.usage.cached_input_tokens + d.usage.cache_creation_input_tokens;
      dailyMap[d.date].actualOutputTokens = d.usage.output_tokens;
      dailyMap[d.date].actualCachedInputTokens = d.usage.cached_input_tokens;
      dailyMap[d.date].actualUncachedInputTokens = d.usage.uncached_input_tokens;
    }
  }
  const dailyBuckets = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
  const chartBuckets = group === 'week' ? groupBucketsByWeek(dailyBuckets, avg) : dailyBuckets;
  if (group === 'week') {
    console.log(`  Grouped into ${chartBuckets.length} week bucket(s)${avg ? ' (per-day averages)' : ''}`);
  }

  const html = generateHtml({
    period, lang, periodStart,
    aiRecords, compileRecords,
    totalProjectedCost, totalEstimatedCost,
    totalInputTokens, totalOutputTokens, costByModel,
    actualCostByModel, actualUsageByModel,
    totalActualInputTokens, totalActualOutputTokens,
    totalActualCachedInputTokens, totalActualUncachedInputTokens,
    hasActualUsage,
    totalAiUnits, totalCompileUnits, cappedRequests, unitsByPlan, totalProjectedRevenue,
    dailyBuckets: chartBuckets,
  });

  writeFileSync(output, html, 'utf-8');
  console.log(`Report written to ${output}`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
