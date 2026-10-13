#!/usr/bin/env node

import admin from 'firebase-admin';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

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

// Legacy "demo" plan is displayed as "free".
const normalizePlan = (plan?: string): string => (!plan || plan === 'demo' ? 'free' : plan);

function parseArgs(argv: string[]): { period: string; output: string } {
  const args = argv.slice(2);
  let period = 'all';
  let output = 'user-report.html';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--period' && args[i + 1]) { period = args[i + 1]; i++; }
    else if (args[i] === '--output' && args[i + 1]) { output = args[i + 1]; i++; }
  }
  if (!['all', 'month', 'week', 'day'].includes(period)) {
    console.error('Error: --period must be "all", "month", "week", or "day"');
    process.exit(1);
  }
  return { period, output };
}

function getPeriodStart(period: string): Date | null {
  if (period === 'all') return null;
  const today = new Date(new Date().toISOString().split('T')[0] + 'T00:00:00Z');
  if (period === 'day') return today;
  if (period === 'week') return new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (period === 'month') return new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  return null;
}

function getTimestampMs(data: any): number | null {
  const ts = data.createdAt;
  if (ts) {
    if (typeof ts.toMillis === 'function') return ts.toMillis();
    if (ts._seconds != null) return ts._seconds * 1000;
    if (ts.seconds != null) return ts.seconds * 1000;
  }
  if (data.timestamp) return new Date(data.timestamp).getTime();
  return null;
}

interface UserInfo {
  uid: string;
  name: string;
  created: string;
  email: string;
  plan: string;
  aiUnits: number;
  compileUnits: number;
}

// Per-user daily usage: { [uid]: { [date]: { ai: number, compile: number } } }
type DailyUsageMap = Record<string, Record<string, { ai: number; compile: number }>>;

// Per-user daily usage by language: { [uid]: { [date]: { [lang]: number } } }
type DailyLangMap = Record<string, Record<string, Record<string, number>>>;

function generateHtml(data: {
  period: string;
  periodStart: Date | null;
  users: UserInfo[];
  usersByPlan: Record<string, number>;
  dailyUsage: DailyUsageMap;
  dailyLang: DailyLangMap;
}): string {
  const now = new Date().toISOString();
  const periodLabel = data.periodStart
    ? `${data.period} (since ${data.periodStart.toISOString().split('T')[0]})`
    : 'all time';

  const totalUsers = data.users.length;
  const plans = Object.entries(data.usersByPlan).sort((a, b) => b[1] - a[1]);

  const planRows = plans
    .map(([plan, count]) => `<tr><td>${plan}</td><td>${count}</td></tr>`)
    .join('\n');

  const sorted = [...data.users].sort((a, b) => (b.aiUnits + b.compileUnits) - (a.aiUnits + a.compileUnits));
  const userRows = sorted
    .map((u, i) => {
      const total = u.aiUnits + u.compileUnits;
      const created = u.created ? u.created.split('T')[0] : '';
      return `<tr class="user-row" data-uid="${u.uid}" data-idx="${i}"><td>${u.uid}</td><td>${u.name}</td><td>${u.email}</td><td>${u.plan}</td><td>${created}</td><td>${u.aiUnits.toLocaleString()}</td><td>${u.compileUnits.toLocaleString()}</td><td>${total.toLocaleString()}</td></tr>
<tr class="chart-row" id="chart-row-${i}"><td colspan="8"><div class="toggle-bar" id="toggles-${i}"></div><div class="chart-cell"><canvas id="chart-${i}"></canvas></div><div class="chart-label">Compiles by Language</div><div class="toggle-bar" id="lang-toggles-${i}"></div><div class="chart-cell"><canvas id="lang-chart-${i}"></canvas></div></td></tr>`;
    })
    .join('\n');

  const dailyUsageJson = JSON.stringify(data.dailyUsage);
  const dailyLangJson = JSON.stringify(data.dailyLang);

  const totalAi = data.users.reduce((s, u) => s + u.aiUnits, 0);
  const totalCompile = data.users.reduce((s, u) => s + u.compileUnits, 0);
  const totalUnits = totalAi + totalCompile;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>User Report</title>
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
  .section { margin-bottom: 32px; }
  .section h2 { font-size: 1.1rem; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); font-size: 0.85rem; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #e2e8f0; }
  th { background: #f1f5f9; font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #475569; }
  td:nth-child(n+6), th:nth-child(n+6) { text-align: right; }
  .user-row { cursor: pointer; }
  .user-row:hover { background: #f1f5f9; }
  .user-row.selected { background: #e0e7ff; }
  .chart-row { display: none; }
  .chart-row.open { display: table-row; }
  .chart-row td { padding: 12px 16px; background: #f8fafc; }
  .chart-cell { height: 250px; position: relative; }
  .chart-label { font-size: 0.8rem; font-weight: 600; color: #475569; margin: 12px 0 4px; }
  .toggle-bar { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .toggle-btn { font-size: 0.75rem; padding: 3px 10px; border-radius: 12px; border: 2px solid; cursor: pointer; font-weight: 500; transition: opacity 0.15s; }
  .toggle-btn.off { opacity: 0.35; }
</style>
</head>
<body>
<h1>User Report</h1>
<p class="subtitle">Period: ${periodLabel} | Generated: ${now}</p>

<div class="cards">
  <div class="card"><div class="label">Total Users</div><div class="value">${totalUsers}</div></div>
${plans.map(([plan, count]) => `  <div class="card"><div class="label">${plan}</div><div class="value">${count}</div><div class="sub">users</div></div>`).join('\n')}
</div>

<div class="section">
  <h2>Users by Plan</h2>
  <table>
    <thead><tr><th>Plan</th><th>Count</th></tr></thead>
    <tbody>${planRows}
      <tr style="font-weight:600"><td>Total</td><td>${totalUsers}</td></tr>
    </tbody>
  </table>
</div>

<div class="section">
  <h2>Per-User Usage</h2>
  <table>
    <thead><tr><th>User</th><th>Screen Name</th><th>Email</th><th>Plan</th><th>Created</th><th>AI Units</th><th>Compile Units</th><th>Total Units</th></tr></thead>
    <tbody>${userRows}
      <tr style="font-weight:600"><td colspan="5">Total</td><td>${totalAi.toLocaleString()}</td><td>${totalCompile.toLocaleString()}</td><td>${totalUnits.toLocaleString()}</td></tr>
    </tbody>
  </table>
</div>

<script>
const dailyUsage = ${dailyUsageJson};
const dailyLang = ${dailyLangJson};
const charts = {};
const langCharts = {};

const LANG_COLORS = [
  'rgb(59,130,246)', 'rgb(168,85,247)', 'rgb(234,88,12)', 'rgb(22,163,74)',
  'rgb(220,38,38)', 'rgb(14,165,233)', 'rgb(217,70,239)', 'rgb(202,138,4)',
];

function makeToggles(container, chart, datasets) {
  container.innerHTML = '';
  datasets.forEach((ds, i) => {
    const btn = document.createElement('button');
    btn.className = 'toggle-btn' + (ds.hidden ? ' off' : '');
    btn.textContent = ds.label;
    btn.style.borderColor = ds.borderColor;
    btn.style.color = ds.borderColor;
    btn.style.background = ds.hidden ? 'transparent' : ds.borderColor + '18';
    btn.addEventListener('click', () => {
      const meta = chart.getDatasetMeta(i);
      meta.hidden = !meta.hidden;
      const off = meta.hidden;
      btn.classList.toggle('off', off);
      btn.style.background = off ? 'transparent' : ds.borderColor + '18';
      chart.update();
    });
    container.appendChild(btn);
  });
}

document.querySelectorAll('.user-row').forEach(row => {
  row.addEventListener('click', () => {
    const uid = row.dataset.uid;
    const idx = row.dataset.idx;
    const chartRow = document.getElementById('chart-row-' + idx);
    const wasOpen = chartRow.classList.contains('open');

    // Close all
    document.querySelectorAll('.chart-row').forEach(r => r.classList.remove('open'));
    document.querySelectorAll('.user-row').forEach(r => r.classList.remove('selected'));

    if (wasOpen) return;

    // Open this one
    row.classList.add('selected');
    chartRow.classList.add('open');

    const userData = dailyUsage[uid];
    if (!userData || Object.keys(userData).length === 0) return;

    // Destroy previous charts for this slot
    if (charts[idx]) { charts[idx].destroy(); charts[idx] = null; }
    if (langCharts[idx]) { langCharts[idx].destroy(); langCharts[idx] = null; }

    const dates = Object.keys(userData).sort();
    const aiData = dates.map(d => userData[d].ai);
    const compileData = dates.map(d => userData[d].compile);

    const usageDatasets = [
      { label: 'AI Units', data: aiData, borderColor: 'rgb(59,130,246)', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.3 },
      { label: 'Compile Units', data: compileData, borderColor: 'rgb(168,85,247)', backgroundColor: 'rgba(168,85,247,0.1)', fill: true, tension: 0.3 },
    ];

    charts[idx] = new Chart(document.getElementById('chart-' + idx), {
      type: 'line',
      data: { labels: dates, datasets: usageDatasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true } }
      }
    });
    makeToggles(document.getElementById('toggles-' + idx), charts[idx], usageDatasets);

    // Language chart
    const langData = dailyLang[uid];
    if (!langData || Object.keys(langData).length === 0) return;

    const langDates = Object.keys(langData).sort();
    const langs = new Set();
    for (const d of langDates) for (const l of Object.keys(langData[d])) langs.add(l);
    const langList = [...langs].sort();

    // Find the most recently used language (most units in the last 7 days with data)
    const recentDates = langDates.slice(-7);
    const recentByLang = {};
    for (const d of recentDates) for (const l of Object.keys(langData[d] || {})) recentByLang[l] = (recentByLang[l] || 0) + langData[d][l];
    const topLang = Object.entries(recentByLang).sort((a, b) => b[1] - a[1])[0]?.[0];

    const langDatasetsList = langList.map((lang, i) => ({
      label: lang,
      data: langDates.map(d => (langData[d] && langData[d][lang]) || 0),
      borderColor: LANG_COLORS[i % LANG_COLORS.length],
      backgroundColor: 'transparent',
      tension: 0.3,
      hidden: lang !== topLang,
    }));

    langCharts[idx] = new Chart(document.getElementById('lang-chart-' + idx), {
      type: 'line',
      data: { labels: langDates, datasets: langDatasetsList },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true } }
      }
    });
    makeToggles(document.getElementById('lang-toggles-' + idx), langCharts[idx], langDatasetsList);
  });
});
</script>
</body>
</html>`;
}

async function main() {
  const { period, output } = parseArgs(process.argv);
  const periodStart = getPeriodStart(period);

  console.log(`Fetching users...`);
  const usersSnap = await db.collection('users').get();
  const userMap: Record<string, UserInfo> = {};
  usersSnap.forEach(doc => {
    const data = doc.data();
    userMap[doc.id] = {
      uid: doc.id,
      name: data.name || '',
      created: data.created || '',
      email: data.email || '',
      plan: normalizePlan(data.subscription?.plan),
      aiUnits: 0,
      compileUnits: 0,
    };
  });
  console.log(`  Found ${Object.keys(userMap).length} users`);

  console.log(`Fetching usage (period: ${period})...`);
  const dailyUsage: DailyUsageMap = {};
  const dailyLang: DailyLangMap = {};
  const usageSnap = await db.collection('usage')
    .where('type', 'in', ['ai_generation', 'compile']).get();
  let count = 0;
  usageSnap.forEach(doc => {
    const data = doc.data();
    const ms = getTimestampMs(data);
    if (!ms) return;
    if (periodStart && ms < periodStart.getTime()) return;
    const uid = data.userId;
    if (!uid) return;
    if (!userMap[uid]) {
      userMap[uid] = { uid, name: '', created: '', email: '', plan: 'free', aiUnits: 0, compileUnits: 0 };
    }
    const units = data.units || 0;
    if (data.type === 'ai_generation') {
      userMap[uid].aiUnits += units;
    } else {
      userMap[uid].compileUnits += units;
    }
    // Collect daily data for chart
    const date = new Date(ms).toISOString().split('T')[0];
    if (!dailyUsage[uid]) dailyUsage[uid] = {};
    if (!dailyUsage[uid][date]) dailyUsage[uid][date] = { ai: 0, compile: 0 };
    if (data.type === 'ai_generation') {
      dailyUsage[uid][date].ai += units;
    } else {
      dailyUsage[uid][date].compile += units;
    }
    // Collect compile data by language
    if (data.type === 'compile') {
      const lang = data.lang || 'unknown';
      if (!dailyLang[uid]) dailyLang[uid] = {};
      if (!dailyLang[uid][date]) dailyLang[uid][date] = {};
      dailyLang[uid][date][lang] = (dailyLang[uid][date][lang] || 0) + units;
    }
    count++;
  });
  console.log(`  Processed ${count} usage records`);

  const users = Object.values(userMap);
  const usersByPlan: Record<string, number> = {};
  for (const u of users) {
    usersByPlan[u.plan] = (usersByPlan[u.plan] || 0) + 1;
  }

  const html = generateHtml({ period, periodStart, users, usersByPlan, dailyUsage, dailyLang });
  writeFileSync(output, html, 'utf-8');
  console.log(`Report written to ${output}`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
