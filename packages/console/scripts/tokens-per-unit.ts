#!/usr/bin/env node
import admin from 'firebase-admin';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

// Load .env.local
const envPath = resolve(process.cwd(), '.env.local');
try {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
  }
} catch {}

delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

if (!process.env.GRAFFITICODE_APP_CREDENTIALS) {
  console.error('Error: GRAFFITICODE_APP_CREDENTIALS not set');
  process.exit(1);
}
process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GRAFFITICODE_APP_CREDENTIALS;

admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: 'graffiticode-app' });
const db = admin.firestore();

type Row = { date: string; inputTokens: number; outputTokens: number; totalTokens: number; aiUnits: number; aiCalls: number };

async function main() {
  const usageDir = resolve(process.cwd(), 'data', 'daily-usage');
  const files = existsSync(usageDir)
    ? readdirSync(usageDir).filter(f => f.startsWith('usage-') && f.endsWith('.json')).sort()
    : [];

  const rows: Record<string, Row> = {};
  for (const f of files) {
    const date = f.replace('usage-', '').replace('.json', '');
    const data = JSON.parse(readFileSync(resolve(usageDir, f), 'utf-8'));
    const t = data.totals || {};
    const input = (t.uncached_input_tokens || 0) + (t.cached_input_tokens || 0);
    const output = t.output_tokens || 0;
    rows[date] = { date, inputTokens: input, outputTokens: output, totalTokens: input + output, aiUnits: 0, aiCalls: 0 };
  }

  const earliest = files[0]?.replace('usage-', '').replace('.json', '');
  const latest = files[files.length - 1]?.replace('usage-', '').replace('.json', '');
  if (!earliest) {
    console.error('No daily-usage files found');
    process.exit(1);
  }

  const snap = await db.collection('usage').where('type', '==', 'ai_generation').get();
  snap.forEach(doc => {
    const r = doc.data() as { units?: number; createdAt?: any; timestamp?: string };
    let ms: number | null = null;
    const ts = r.createdAt;
    if (ts) {
      if (typeof ts.toMillis === 'function') ms = ts.toMillis();
      else if (ts._seconds != null) ms = ts._seconds * 1000;
      else if (ts.seconds != null) ms = ts.seconds * 1000;
    }
    if (!ms && r.timestamp) ms = new Date(r.timestamp).getTime();
    if (!ms) return;
    const date = new Date(ms).toISOString().split('T')[0];
    if (date < earliest || date > latest) return;
    if (!rows[date]) rows[date] = { date, inputTokens: 0, outputTokens: 0, totalTokens: 0, aiUnits: 0, aiCalls: 0 };
    rows[date].aiUnits += r.units || 0;
    rows[date].aiCalls += 1;
  });

  const sorted = Object.values(rows).sort((a, b) => a.date.localeCompare(b.date));

  console.log('date         tokens      ai_units  calls   tok/unit  tok/call');
  console.log('----------   ----------  --------  ------  --------  --------');
  for (const r of sorted) {
    const tokPerUnit = r.aiUnits > 0 ? (r.totalTokens / r.aiUnits).toFixed(0) : '-';
    const tokPerCall = r.aiCalls > 0 ? (r.totalTokens / r.aiCalls).toFixed(0) : '-';
    console.log(
      `${r.date}   ${String(r.totalTokens).padStart(10)}  ${String(r.aiUnits).padStart(8)}  ${String(r.aiCalls).padStart(6)}  ${String(tokPerUnit).padStart(8)}  ${String(tokPerCall).padStart(8)}`
    );
  }

  // Weekly rollup
  console.log('\nWeekly rollup (7-day chunks):');
  console.log('week_start   tokens      ai_units  calls   tok/unit  tok/call');
  console.log('----------   ----------  --------  ------  --------  --------');
  for (let i = 0; i < sorted.length; i += 7) {
    const chunk = sorted.slice(i, i + 7);
    const tokens = chunk.reduce((s, r) => s + r.totalTokens, 0);
    const units = chunk.reduce((s, r) => s + r.aiUnits, 0);
    const calls = chunk.reduce((s, r) => s + r.aiCalls, 0);
    const tokPerUnit = units > 0 ? (tokens / units).toFixed(0) : '-';
    const tokPerCall = calls > 0 ? (tokens / calls).toFixed(0) : '-';
    console.log(
      `${chunk[0].date}   ${String(tokens).padStart(10)}  ${String(units).padStart(8)}  ${String(calls).padStart(6)}  ${String(tokPerUnit).padStart(8)}  ${String(tokPerCall).padStart(8)}`
    );
  }
}

main().catch(err => { console.error(err); process.exit(1); });
