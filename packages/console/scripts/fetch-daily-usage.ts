#!/usr/bin/env node

// Fetch a day's production Anthropic usage from the Admin API's usage report and
// save it to data/daily-usage/usage-<date>.json (read by revenue-vs-cost.ts).
// Usage: npx tsx scripts/fetch-daily-usage.ts [--date YYYY-MM-DD] [--tz IANA_TIMEZONE]
// Requires: ANTHROPIC_ADMIN_KEY (from the shell or .env.local)
//
// "Production" is the console's identity, which changed on 2026-10-24: until
// then it called Claude with the `graffiticode-console` API key; since then it
// authenticates with Workload Identity Federation, and the usage report
// attributes that traffic to a service account instead of a key. A day is the
// sum of both, so days on either side of the switch (and the day of it) count
// correctly. Override with ANTHROPIC_CONSOLE_KEY_IDS (key ids or names) and
// ANTHROPIC_CONSOLE_SERVICE_ACCOUNT_IDS (svac_ ids), comma-separated.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

// Load .env.local: this directory's, else the repo root's.
for (const envPath of [resolve(process.cwd(), '.env.local'), resolve(process.cwd(), '../../.env.local')]) {
  try {
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
      if (match) process.env[match[1]] = match[2];
    }
    break;
  } catch {}
}

// The console's production identities (not secrets: ids that name them).
const CONSOLE_KEY_IDS = ['apikey_01HXtW4mos89SZwqN4NznJ1c']; // graffiticode-console, deleted 2026-10-24
const CONSOLE_SERVICE_ACCOUNT_IDS = ['svac_01QLoHvFLSei6QT2DCGMkPKU']; // the console's federation service account

const ADMIN_KEY = process.env.ANTHROPIC_ADMIN_KEY;
if (!ADMIN_KEY) {
  console.error('Error: ANTHROPIC_ADMIN_KEY environment variable not set');
  process.exit(1);
}

async function apiFetch(url: string): Promise<any> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch(url, {
      headers: { 'anthropic-version': '2023-06-01', 'x-api-key': ADMIN_KEY! },
    });
    if (resp.status === 429) {
      const wait = (attempt + 1) * 15;
      console.log(`Rate limited, waiting ${wait}s...`);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`API error (${resp.status}): ${body}`);
    }
    return await resp.json();
  }
  throw new Error('Failed after 3 retries');
}

const list = (v: string | undefined) => (v || '').split(',').map(x => x.trim()).filter(Boolean);

// The key ids and service account ids whose usage counts as production. Key
// names in ANTHROPIC_CONSOLE_KEY_IDS resolve through the org's key list; ids are
// taken as given, since a deleted key's id still labels its past usage.
async function resolveIdentities(): Promise<{ apiKeyIds: string[]; serviceAccountIds: string[] }> {
  const wanted = process.env.ANTHROPIC_CONSOLE_KEY_IDS ? list(process.env.ANTHROPIC_CONSOLE_KEY_IDS) : CONSOLE_KEY_IDS;
  const apiKeyIds = wanted.filter(w => w.startsWith('apikey_'));
  const names = wanted.filter(w => !w.startsWith('apikey_')).map(n => n.toLowerCase());
  let afterId: string | undefined;
  while (names.length) {
    const params = new URLSearchParams({ limit: '100' });
    if (afterId) params.set('after_id', afterId);
    const data = await apiFetch(`https://api.anthropic.com/v1/organizations/api_keys?${params}`);
    for (const key of data.data || []) {
      if (names.includes(String(key.name || '').toLowerCase())) apiKeyIds.push(key.id);
    }
    afterId = data.has_more ? data.last_id : undefined;
    if (!afterId) break;
  }
  const serviceAccountIds = process.env.ANTHROPIC_CONSOLE_SERVICE_ACCOUNT_IDS
    ? list(process.env.ANTHROPIC_CONSOLE_SERVICE_ACCOUNT_IDS) : CONSOLE_SERVICE_ACCOUNT_IDS;
  return { apiKeyIds: [...new Set(apiKeyIds)], serviceAccountIds };
}

type TokenStats = { input: number; cached_input: number; cache_creation: number; output: number; web_searches: number };

async function main() {
  // Accept optional --date YYYY-MM-DD and --tz IANA_TIMEZONE arguments
  const dateArg = process.argv.find((_, i) => process.argv[i - 1] === '--date');
  const tzArg = process.argv.find((_, i) => process.argv[i - 1] === '--tz');
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const dateStr = dateArg || new Date(new Date(today).getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  // Calculate UTC offset for the given timezone on the given date
  function getUtcOffset(date: string, tz: string): string {
    const d = new Date(date + 'T12:00:00'); // noon to avoid DST edge cases
    const utcStr = d.toLocaleString('en-US', { timeZone: 'UTC' });
    const tzStr = d.toLocaleString('en-US', { timeZone: tz });
    const diffMs = new Date(utcStr).getTime() - new Date(tzStr).getTime();
    const diffH = Math.round(diffMs / (60 * 60 * 1000));
    const sign = diffH >= 0 ? '+' : '-';
    return `${sign}${String(Math.abs(diffH)).padStart(2, '0')}:00`;
  }

  let startingAt: string, endingAt: string;
  if (tzArg) {
    const offset = getUtcOffset(dateStr, tzArg);
    const nextDay = new Date(new Date(dateStr).getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    // Convert local midnight to UTC
    const startLocal = new Date(`${dateStr}T00:00:00${offset}`);
    const endLocal = new Date(`${nextDay}T00:00:00${offset}`);
    startingAt = startLocal.toISOString().replace(/\.\d+Z$/, 'Z');
    endingAt = endLocal.toISOString().replace(/\.\d+Z$/, 'Z');
  } else {
    const nextDay = new Date(new Date(dateStr).getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    startingAt = dateStr + 'T00:00:00Z';
    endingAt = nextDay + 'T00:00:00Z';
  }

  console.log(`Fetching usage for ${dateStr}...`);

  // One unfiltered report grouped by identity, kept where the row's key or
  // service account is production's. (Filtering on both key and service
  // account would match neither: a request carries one or the other.)
  const ids = await resolveIdentities();
  if (!ids.apiKeyIds.length && !ids.serviceAccountIds.length) {
    console.error('Error: no production identity resolved; set ANTHROPIC_CONSOLE_KEY_IDS or ANTHROPIC_CONSOLE_SERVICE_ACCOUNT_IDS');
    process.exit(1);
  }
  console.log(`  Production: keys ${ids.apiKeyIds.join(', ') || '(none)'}; service accounts ${ids.serviceAccountIds.join(', ') || '(none)'}`);
  console.log(`  Range: ${startingAt} to ${endingAt}`);
  const params = new URLSearchParams({ starting_at: startingAt, ending_at: endingAt, bucket_width: '1h', limit: '168' });
  for (const g of ['model', 'api_key_id', 'service_account_id']) params.append('group_by[]', g);
  const report: any = { data: [] };
  for (let page: string | undefined, first = true; first || page; first = false) {
    if (page) params.set('page', page);
    const chunk = await apiFetch(`https://api.anthropic.com/v1/organizations/usage_report/messages?${params}`);
    report.data.push(...(chunk.data || []));
    page = chunk.has_more ? chunk.next_page : undefined;
  }
  const isProduction = (r: any) => (r.api_key_id && ids.apiKeyIds.includes(r.api_key_id)) ||
    (r.service_account_id && ids.serviceAccountIds.includes(r.service_account_id));
  for (const bucket of report.data) bucket.results = (bucket.results || []).filter(isProduction);

  // Summarize
  let totalInput = 0, totalCachedInput = 0, totalCacheCreation = 0, totalOutput = 0, totalWebSearches = 0;
  const byModel: Record<string, TokenStats> = {};

  for (const bucket of report.data || []) {
    for (const r of bucket.results) {
      const input = r.uncached_input_tokens || 0;
      const cachedInput = r.cache_read_input_tokens || 0;
      const cacheCreation = (r.cache_creation?.ephemeral_1h_input_tokens || 0) + (r.cache_creation?.ephemeral_5m_input_tokens || 0);
      const output = r.output_tokens || 0;
      const webSearches = r.server_tool_use?.web_search_requests || 0;
      const model = r.model || 'unknown';

      totalInput += input;
      totalCachedInput += cachedInput;
      totalCacheCreation += cacheCreation;
      totalOutput += output;
      totalWebSearches += webSearches;

      if (!byModel[model]) byModel[model] = { input: 0, cached_input: 0, cache_creation: 0, output: 0, web_searches: 0 };
      byModel[model].input += input;
      byModel[model].cached_input += cachedInput;
      byModel[model].cache_creation += cacheCreation;
      byModel[model].output += output;
      byModel[model].web_searches += webSearches;
    }
  }

  const result = {
    date: dateStr,
    fetched_at: now.toISOString(),
    period: { starting_at: startingAt, ending_at: endingAt },
    identities: { api_key_ids: ids.apiKeyIds, service_account_ids: ids.serviceAccountIds },
    totals: {
      uncached_input_tokens: totalInput,
      cached_input_tokens: totalCachedInput,
      cache_creation_input_tokens: totalCacheCreation,
      output_tokens: totalOutput,
      total_tokens: totalInput + totalCachedInput + totalCacheCreation + totalOutput,
      web_search_count: totalWebSearches,
    },
    by_model: byModel,
    raw: report,
  };

  const dir = resolve(process.cwd(), 'data', 'daily-usage');
  mkdirSync(dir, { recursive: true });
  const filename = `usage-${dateStr}.json`;
  const filepath = resolve(dir, filename);
  writeFileSync(filepath, JSON.stringify(result, null, 2) + '\n', 'utf-8');

  const totalAll = totalInput + totalCachedInput + totalCacheCreation + totalOutput;
  console.log(`Total tokens: ${totalAll.toLocaleString()}`);
  console.log(`  Input: ${totalInput.toLocaleString()} | Cached: ${totalCachedInput.toLocaleString()} | Output: ${totalOutput.toLocaleString()}`);
  for (const [model, stats] of Object.entries(byModel).sort((a, b) => (b[1].input + b[1].output) - (a[1].input + a[1].output))) {
    const total = stats.input + stats.cached_input + stats.cache_creation + stats.output;
    console.log(`  ${model}: ${total.toLocaleString()} tokens`);
  }
  console.log(`Written to ${filepath}`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
