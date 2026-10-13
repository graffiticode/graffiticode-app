#!/usr/bin/env node

// Fetch previous day's usage from the Anthropic Admin API, filtered to the
// console's API key (ANTHROPIC_API_KEY in .env.local), and save to a JSON file.
// Usage: npx tsx scripts/fetch-daily-usage.ts
// Requires: ANTHROPIC_ADMIN_KEY environment variable

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

// Load .env.local
const envPath = resolve(process.cwd(), '.env.local');
try {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
    if (match) process.env[match[1]] = match[2];
  }
} catch {}

const ADMIN_KEY = process.env.ANTHROPIC_ADMIN_KEY;
if (!ADMIN_KEY) {
  console.error('Error: ANTHROPIC_ADMIN_KEY environment variable not set');
  process.exit(1);
}

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable not set');
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

// Find the API key ID to snapshot.
//
// ANTHROPIC_CONSOLE_KEY_IDS wins when set: since local dev moved onto its own
// key, ANTHROPIC_API_KEY names the DEV key, and matching against it would
// quietly snapshot developer traffic instead of production's.
//
// Otherwise fall back to matching the key value against partial hints, which
// look like "sk-ant-api03-mR3...sQAA" — prefix before "..." and suffix after.
async function findApiKeyId(): Promise<{ id: string; name: string } | null> {
  const wanted = (process.env.ANTHROPIC_CONSOLE_KEY_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  let afterId: string | undefined;
  do {
    const params = new URLSearchParams({ limit: '100' });
    if (afterId) params.set('after_id', afterId);
    const data = await apiFetch(`https://api.anthropic.com/v1/organizations/api_keys?${params}`);
    if (wanted.length > 0) {
      for (const key of data.data || []) {
        if (wanted.includes(key.id) ||
            wanted.some(w => w.toLowerCase() === String(key.name || '').toLowerCase())) {
          return { id: key.id, name: key.name };
        }
      }
      afterId = data.has_more ? data.last_id : undefined;
      continue;
    }
    for (const key of data.data || []) {
      const hint = key.partial_key_hint || '';
      const dotIdx = hint.indexOf('...');
      if (dotIdx === -1) continue;
      const prefix = hint.slice(0, dotIdx);
      const suffix = hint.slice(dotIdx + 3);
      if (API_KEY!.startsWith(prefix) && API_KEY!.endsWith(suffix)) {
        return { id: key.id, name: key.name };
      }
    }
    afterId = data.has_more ? data.last_id : undefined;
  } while (afterId);
  return null;
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

  // Resolve API key ID, try filtered first, fall back to all keys if empty
  const apiKey = await findApiKeyId();
  const baseParams = { starting_at: startingAt, ending_at: endingAt, bucket_width: '1h', 'group_by[]': 'model' };
  let report: any;
  let usedAllKeys = false;

  if (apiKey) {
    console.log(`  Filtering to key: ${apiKey.name} (${apiKey.id})`);
    const params = new URLSearchParams({ ...baseParams, 'api_key_ids[]': apiKey.id });
    console.log(`  Range: ${startingAt} to ${endingAt}`);
    report = await apiFetch(`https://api.anthropic.com/v1/organizations/usage_report/messages?${params}`);
    const hasData = (report.data || []).some((b: any) => b.results && b.results.length > 0);
    if (!hasData) {
      console.log('  No usage data for this key, falling back to all keys');
      const allParams = new URLSearchParams(baseParams);
      report = await apiFetch(`https://api.anthropic.com/v1/organizations/usage_report/messages?${allParams}`);
      usedAllKeys = true;
    }
  } else {
    console.log('  Could not match API key, using usage for all keys');
    const params = new URLSearchParams(baseParams);
    console.log(`  Range: ${startingAt} to ${endingAt}`);
    report = await apiFetch(`https://api.anthropic.com/v1/organizations/usage_report/messages?${params}`);
    usedAllKeys = true;
  }

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
    api_key: apiKey && !usedAllKeys ? { id: apiKey.id, name: apiKey.name } : { id: 'all', name: 'all keys' },
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
