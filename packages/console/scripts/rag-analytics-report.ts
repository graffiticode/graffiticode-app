#!/usr/bin/env node

import admin from 'firebase-admin';
import { writeFileSync } from 'fs';

// Force connection to production Firestore (bypass emulator)
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

// Use GRAFFITICODE_APP_CREDENTIALS for the graffiticode-app project
if (process.env.GRAFFITICODE_APP_CREDENTIALS) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GRAFFITICODE_APP_CREDENTIALS;
} else {
  console.error('Error: GRAFFITICODE_APP_CREDENTIALS environment variable not set');
  console.error('Set it to the path of your graffiticode-app service account key');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "graffiticode-app"
});
const db = admin.firestore();

function parseArgs(argv: string[]): { period: string; output: string; language?: string } {
  const args = argv.slice(2);
  let period = 'all';
  let output = 'rag-analytics-report.html';
  let language: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--period' && args[i + 1]) {
      period = args[i + 1];
      i++;
    } else if (args[i] === '--output' && args[i + 1]) {
      output = args[i + 1];
      i++;
    } else if (args[i] === '--lang' && args[i + 1]) {
      const raw = args[i + 1].toUpperCase();
      language = /^\d+$/.test(raw) ? `L${raw}` : raw;
      i++;
    }
  }
  if (!['all', 'week', 'day', 'hour'].includes(period) && !/^\d+d$/.test(period)) {
    console.error('Error: --period must be "all", "week", "day", "hour", or "<N>d" (e.g. "2d")');
    process.exit(1);
  }
  return { period, output, language };
}

interface RetrievalDoc {
  similarity: number;
  keywordScore?: number;
  combinedScore?: number;
  embeddingText?: string;
  prompt?: string;
  codeSnippet?: string;
  position?: number;
  wasUsedInPrompt?: boolean;
}

interface AnalyticsDoc {
  requestId: string;
  timestamp: FirebaseFirestore.Timestamp;
  query?: { text?: string; language?: string; embeddingText?: string };
  retrieval?: { documents?: RetrievalDoc[]; retrievalLatencyMs?: number };
  generation?: { success?: boolean; latencyMs?: number; model?: string };
  compilation?: { success?: boolean; errorMessage?: string; retryCount?: number };
  response?: { success?: boolean; code?: string };
  feedback?: { score?: number };
  judge?: { overall?: number; correctness?: number; instructionFollowing?: number; idiomaticity?: number };
  performance?: { totalLatencyMs?: number; stages?: Array<{ stage: string; startTime?: number; endTime?: number; durationMs?: number }> };
  errors?: Array<{ stage: string; message: string }>;
  metadata?: Record<string, any>;
}

function getLanguage(d: AnalyticsDoc): string {
  const raw = (d.metadata?.lang || d.query?.language || 'unknown').toString();
  // Normalize to L-prefixed uppercase form (e.g. "0166" -> "L0166")
  if (/^\d+$/.test(raw)) return `L${raw}`;
  return raw.toUpperCase();
}

// Which model actually served the request. Set from the resolved family ordering
// in src/lib/model-priority.ts, so this is also how you see a failover to the
// second family. Older records predate the field.
function getModel(d: AnalyticsDoc): string {
  return (d.generation?.model || d.metadata?.model || 'unrecorded').toString();
}

const normText = (v: unknown) => String(v ?? '').trim().replace(/\s+/g, ' ');

/**
 * The best retrieved example for a request, and whether it is the request's own
 * prompt coming back.
 *
 * A training prompt that was downloaded into the corpus retrieves ITSELF at
 * similarity 1.0. That is corpus contamination, not retrieval quality, and it
 * dominates any window with training traffic in it: on one L0176 day, 61 of 205
 * requests matched an example whose stored prompt was byte-identical to the
 * query, pulling the mean top-1 from 0.718 to 0.802.
 *
 * Identical text embeds identically, so the prompt comparison is the real test;
 * the >= 0.999 arm catches the same case when the corpus entry's prompt was not
 * stored alongside the match.
 */
function topMatchOf(d: AnalyticsDoc): { doc: RetrievalDoc; similarity: number; selfMatch: boolean } | null {
  const documents = (d.retrieval?.documents ?? []).filter(x => typeof x.similarity === 'number');
  if (documents.length === 0) return null;
  const best = [...documents].sort((a, b) => b.similarity - a.similarity)[0];
  const query = normText(d.query?.text ?? d.query?.embeddingText);
  const matched = normText(best.prompt ?? best.embeddingText);
  return {
    doc: best,
    similarity: best.similarity,
    selfMatch: (query.length > 0 && matched === query) || best.similarity >= 0.999,
  };
}

function getTimestampMs(d: AnalyticsDoc): number | null {
  // Try the Firestore timestamp first
  const ts = d.timestamp as any;
  if (ts) {
    if (typeof ts.toMillis === 'function') return ts.toMillis();
    if (typeof ts.toDate === 'function') return ts.toDate().getTime();
    if (ts._seconds != null) return ts._seconds * 1000;
    if (ts.seconds != null) return ts.seconds * 1000;
  }
  // Fallback: use the request stage startTime from performance data
  const stages = d.performance?.stages as any[];
  if (stages?.length > 0 && stages[0].startTime) return stages[0].startTime;
  return null;
}

function formatTimestamp(d: AnalyticsDoc, period?: string): string {
  const ms = getTimestampMs(d);
  if (ms == null) return '—';
  const date = new Date(ms);
  if (period === 'hour' || period === 'day') {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } else if (period === 'week') {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toISOString();
}

interface UsageInfo {
  units: number;
  /**
   * TOTAL prompt tokens = the record's uncached `input` plus both cache buckets.
   *
   * The stored `tokens.input` is uncached-only: TokenUsage in
   * llm-generation-service.ts uses a disjoint convention, so cached input lives in
   * `cacheRead`/`cacheCreation` instead. Reading `input` alone is not comparable
   * ACROSS PROVIDERS — Anthropic caches only to explicit cache_control breakpoints
   * (leaving the query and retrieved examples uncached every call), while OpenAI
   * auto-caches the whole prefix, so its residue is near zero for the same prompt.
   * Summing the three restores an apples-to-apples number.
   */
  inputTokens: number;
  outputTokens: number;
  /** Cache buckets kept separately so the hit rate stays visible, not averaged away. */
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

async function fetchUsageInfo(requestIds: string[]): Promise<Map<string, UsageInfo>> {
  const info = new Map<string, UsageInfo>();
  if (requestIds.length === 0) return info;

  // Query usage collection for matching taskIds
  const snapshot = await db.collection('usage')
    .where('type', '==', 'ai_generation')
    .get();

  snapshot.forEach(doc => {
    const data = doc.data();
    if (data.taskId && requestIds.includes(data.taskId)) {
      const cacheRead = data.tokens?.cacheRead || 0;
      const cacheCreation = data.tokens?.cacheCreation || 0;
      const newRecord = {
        units: data.units || 0,
        inputTokens: (data.tokens?.input || 0) + cacheRead + cacheCreation,
        outputTokens: data.tokens?.output || 0,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreation,
      };
      const existing = info.get(data.taskId);
      if (existing) {
        // Multiple ai_generation docs can share one rid (e.g. head+upstream composition,
        // or now more common with routing/spec/judge also recording under the same rid).
        // Accumulate rather than overwrite so all their tokens are counted.
        info.set(data.taskId, {
          units: existing.units + newRecord.units,
          inputTokens: existing.inputTokens + newRecord.inputTokens,
          outputTokens: existing.outputTokens + newRecord.outputTokens,
          cacheReadTokens: existing.cacheReadTokens + newRecord.cacheReadTokens,
          cacheCreationTokens: existing.cacheCreationTokens + newRecord.cacheCreationTokens,
        });
      } else {
        info.set(data.taskId, newRecord);
      }
    }
  });

  return info;
}

async function fetchDocs(period: string, language?: string): Promise<AnalyticsDoc[]> {
  const snapshot = await db.collection('rag_analytics').get();

  let docs: AnalyticsDoc[] = [];
  snapshot.forEach(doc => {
    docs.push({ requestId: doc.id, ...doc.data() } as AnalyticsDoc);
  });

  // Filter by period using stage startTime (Firestore timestamp field is unreliable)
  if (period !== 'all') {
    const now = Date.now();
    const daysMatch = /^(\d+)d$/.exec(period);
    const cutoffMs = now - (period === 'hour' ? 3600000 : period === 'day' ? 86400000 : daysMatch ? parseInt(daysMatch[1]) * 86400000 : 7 * 86400000);
    docs = docs.filter(d => {
      const ms = getTimestampMs(d);
      return ms != null && ms >= cutoffMs;
    });
  }

  if (language) {
    docs = docs.filter(d => getLanguage(d) === language);
  }
  return docs;
}

function computeMetrics(docs: AnalyticsDoc[], usageInfo?: Map<string, UsageInfo>) {
  const total = docs.length;
  const successful = docs.filter(d => d.response?.success || d.metadata?.success).length;
  const successRate = total > 0 ? successful / total : 0;

  const latencies = docs.map(d => d.performance?.totalLatencyMs).filter((v): v is number => v != null);
  const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;

  // Top-1 similarity, with the two distortions of a training-heavy window taken
  // out. Both matter, and they compound:
  //
  //   1. Self-matches (see topMatchOf) are the prompt retrieving itself. Excluded.
  //   2. The harness replays the same prompts, and the replayed ones are the easy
  //      ones — on that same L0176 day, prompts seen more than once averaged 0.858
  //      against 0.744 for prompts seen once. Averaging per RECORD weights every
  //      prompt by how many times it was rerun, so each DISTINCT QUERY gets one
  //      vote instead.
  //
  // The raw per-record figure is kept and shown beside it, because a divergence
  // between the two IS the signal that the window is mostly replayed training.
  const topMatches = docs.map(d => ({ d, m: topMatchOf(d) }))
    .filter((x): x is { d: AnalyticsDoc; m: NonNullable<ReturnType<typeof topMatchOf>> } => x.m != null);
  const avgTopSimilarityRaw = topMatches.length > 0
    ? topMatches.reduce((a, x) => a + x.m.similarity, 0) / topMatches.length : 0;
  const selfMatchCount = topMatches.filter(x => x.m.selfMatch).length;

  // Group the surviving records by query text. A record with no query text can't
  // be grouped, so it keeps its own bucket rather than merging with every other
  // untexted record into one vote.
  const byQuery = new Map<string, number[]>();
  topMatches.filter(x => !x.m.selfMatch).forEach((x, i) => {
    const key = normText(x.d.query?.text ?? x.d.query?.embeddingText) || `\u0000untexted:${i}`;
    if (!byQuery.has(key)) byQuery.set(key, []);
    byQuery.get(key)!.push(x.m.similarity);
  });
  const perQuery = [...byQuery.values()].map(v => v.reduce((a, b) => a + b, 0) / v.length);
  const avgTopSimilarity = perQuery.length > 0 ? perQuery.reduce((a, b) => a + b, 0) / perQuery.length : 0;
  const similarityRecords = topMatches.length;
  const distinctQueries = byQuery.size;

  const feedbacks = docs.map(d => d.feedback?.score).filter((v): v is number => v != null);
  const avgFeedback = feedbacks.length > 0 ? feedbacks.reduce((a, b) => a + b, 0) / feedbacks.length : 0;

  // LLM-as-judge overall quality (async, above the compile line — only present when JUDGE_MODE=async)
  const judgeScores = docs.map(d => d.judge?.overall).filter((v): v is number => v != null);
  const avgJudgeOverall = judgeScores.length > 0 ? judgeScores.reduce((a, b) => a + b, 0) / judgeScores.length : 0;

  // Error breakdown
  const errorCounts = new Map<string, number>();
  docs.forEach(d => {
    d.errors?.forEach(e => {
      const key = `${e.stage}: ${e.message.substring(0, 80)}`;
      errorCounts.set(key, (errorCounts.get(key) || 0) + 1);
    });
  });
  const errorBreakdown = Array.from(errorCounts.entries())
    .map(([error, count]) => ({ error, count }))
    .sort((a, b) => b.count - a.count);

  // Per-language breakdown
  const langMap = new Map<string, { total: number; successful: number; totalLatency: number; latencyCount: number; judgeSum: number; judgeCount: number }>();
  docs.forEach(d => {
    const lang = getLanguage(d);
    const entry = langMap.get(lang) || { total: 0, successful: 0, totalLatency: 0, latencyCount: 0, judgeSum: 0, judgeCount: 0 };
    entry.total++;
    if (d.response?.success || d.metadata?.success) entry.successful++;
    if (d.performance?.totalLatencyMs != null) {
      entry.totalLatency += d.performance.totalLatencyMs;
      entry.latencyCount++;
    }
    if (d.judge?.overall != null) { entry.judgeSum += d.judge.overall; entry.judgeCount++; }
    langMap.set(lang, entry);
  });
  const languageBreakdown = Array.from(langMap.entries())
    .map(([lang, s]) => ({
      language: lang,
      total: s.total,
      successRate: s.total > 0 ? s.successful / s.total : 0,
      avgLatency: s.latencyCount > 0 ? s.totalLatency / s.latencyCount : 0,
      avgJudge: s.judgeCount > 0 ? s.judgeSum / s.judgeCount : null,
    }))
    .sort((a, b) => b.total - a.total);

  // Per-model breakdown. Retries are the error-correction rounds, so a model with a
  // high success rate but nonzero avg retries is passing on the second try.
  const modelMap = new Map<string, { total: number; successful: number; totalLatency: number; latencyCount: number; retrySum: number; firstPass: number; inputTokens: number; outputTokens: number; cacheReadTokens: number }>();
  docs.forEach(d => {
    const model = getModel(d);
    const entry = modelMap.get(model) || { total: 0, successful: 0, totalLatency: 0, latencyCount: 0, retrySum: 0, firstPass: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    entry.total++;
    const ok = !!(d.response?.success || d.metadata?.success);
    if (ok) entry.successful++;
    const retries = d.compilation?.retryCount ?? 0;
    entry.retrySum += retries;
    if (ok && retries === 0) entry.firstPass++;
    if (d.performance?.totalLatencyMs != null) {
      entry.totalLatency += d.performance.totalLatencyMs;
      entry.latencyCount++;
    }
    const info = usageInfo?.get(d.requestId);
    if (info) {
      entry.inputTokens += info.inputTokens;
      entry.outputTokens += info.outputTokens;
      entry.cacheReadTokens += info.cacheReadTokens;
    }
    modelMap.set(model, entry);
  });
  const modelBreakdown = Array.from(modelMap.entries())
    .map(([model, s]) => ({
      model,
      total: s.total,
      successRate: s.total > 0 ? s.successful / s.total : 0,
      firstPassRate: s.total > 0 ? s.firstPass / s.total : 0,
      avgLatency: s.latencyCount > 0 ? s.totalLatency / s.latencyCount : 0,
      avgRetries: s.total > 0 ? s.retrySum / s.total : 0,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      // Share of total prompt tokens served from cache. Differs by provider for
      // structural reasons (see UsageInfo.inputTokens), so compare within a model.
      cacheHitRate: s.inputTokens > 0 ? s.cacheReadTokens / s.inputTokens : null,
    }))
    .sort((a, b) => b.total - a.total);

  // Total compile units and tokens
  let totalCompileUnits = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  if (usageInfo) {
    docs.forEach(d => {
      const info = usageInfo.get(d.requestId);
      if (info) {
        totalCompileUnits += info.units;
        totalInputTokens += info.inputTokens;
        totalOutputTokens += info.outputTokens;
        totalCacheReadTokens += info.cacheReadTokens;
      }
    });
  }
  const cacheHitRate = totalInputTokens > 0 ? totalCacheReadTokens / totalInputTokens : null;

  return { total, successful, successRate, avgLatency, avgTopSimilarity, avgTopSimilarityRaw,
    similarityRecords, distinctQueries, selfMatchCount, avgFeedback, feedbackCount: feedbacks.length, avgJudgeOverall, judgeCount: judgeScores.length, errorBreakdown, languageBreakdown, modelBreakdown, totalCompileUnits, totalInputTokens, totalOutputTokens, totalCacheReadTokens, cacheHitRate };
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function generateHtml(docs: AnalyticsDoc[], metrics: ReturnType<typeof computeMetrics>, period: string, language?: string, usageInfo?: Map<string, UsageInfo>): string {
  const now = new Date().toISOString();
  const langLabel = language ? ` | Language: ${language}` : '';

  // Error table rows
  const errorRows = metrics.errorBreakdown.map(e =>
    `<tr><td>${escapeHtml(e.error)}</td><td>${e.count}</td></tr>`
  ).join('\n');

  // Language breakdown rows
  const langRows = metrics.languageBreakdown.map(l =>
    `<tr><td>${escapeHtml(l.language)}</td><td>${l.total}</td><td>${(l.successRate * 100).toFixed(1)}%</td><td>${Math.round(l.avgLatency)}ms</td><td>${l.avgJudge != null ? l.avgJudge.toFixed(2) : '—'}</td></tr>`
  ).join('\n');

  // Model breakdown rows
  const modelRows = metrics.modelBreakdown.map(m =>
    `<tr><td class="model">${escapeHtml(m.model)}</td><td>${m.total}</td><td>${(m.successRate * 100).toFixed(1)}%</td><td>${(m.firstPassRate * 100).toFixed(1)}%</td><td>${m.avgRetries.toFixed(2)}</td><td>${Math.round(m.avgLatency)}ms</td><td>${m.inputTokens > 0 ? m.inputTokens.toLocaleString() : '—'}</td><td>${m.cacheHitRate != null ? (m.cacheHitRate * 100).toFixed(1) + '%' : '—'}</td><td>${m.outputTokens > 0 ? m.outputTokens.toLocaleString() : '—'}</td></tr>`
  ).join('\n');

  // Card value: one model gets its name; several get a name + share list, because a
  // split is usually a failover to the second family and "which one, how much" is
  // the whole question. Beyond three, the tail collapses into a count.
  const modelCard = (() => {
    const ms = metrics.modelBreakdown;
    if (ms.length === 0) return '—';
    if (ms.length === 1) return `<span class="model-name">${escapeHtml(ms[0].model)}</span>`;
    const shown = ms.slice(0, 3).map(m =>
      `<span class="model-split"><span class="model-name">${escapeHtml(m.model)}</span><span class="model-share">${Math.round((m.total / metrics.total) * 100)}%</span></span>`
    ).join('');
    const rest = ms.length - 3;
    return shown + (rest > 0 ? `<span class="model-split model-more">+${rest} more</span>` : '');
  })();

  // Sort docs by timestamp descending for detail table
  const sorted = [...docs].sort((a, b) => (getTimestampMs(b) || 0) - (getTimestampMs(a) || 0));

  // Detail table rows with expandable panels
  const detailRows = sorted.map((d, i) => {
    const ts = formatTimestamp(d, period);
    const lang = getLanguage(d);
    const model = getModel(d);
    const query = escapeHtml((d.query?.text || '—').substring(0, 60));
    const success = d.response?.success ? 'Yes' : 'No';
    const latency = d.performance?.totalLatencyMs != null ? `${Math.round(d.performance.totalLatencyMs)}ms` : '—';
    const best = topMatchOf(d);
    // Flagged inline so a row reading 1.000 is not mistaken for a good retrieval.
    const topSim = best
      ? `${best.similarity.toFixed(3)}${best.selfMatch ? ' <span class="self-match" title="Top match is this request\'s own prompt — the corpus contains the query">self</span>' : ''}`
      : '—';
    const retries = d.compilation?.retryCount ? `${d.compilation.retryCount}` : '0';
    const info = usageInfo?.get(d.requestId);
    const unitsStr = info != null ? info.units.toLocaleString() : '—';
    const inputTokensStr = info?.inputTokens ? info.inputTokens.toLocaleString() : '—';
    const outputTokensStr = info?.outputTokens ? info.outputTokens.toLocaleString() : '—';
    const successClass = d.response?.success ? 'success' : 'failure';

    // Build expandable detail content
    const fullQuery = escapeHtml(d.query?.text || '—');
    const responseCode = escapeHtml(d.response?.code || '—');
    const embeddingText = escapeHtml(d.query?.embeddingText || '—');

    // Top match from retrieval
    const topMatch = best?.doc ?? null;
    const matchPrompt = topMatch ? escapeHtml(topMatch.prompt || '—') : '—';
    const matchSim = topMatch ? topMatch.similarity.toFixed(4) : '—';

    // Build markdown for clipboard
    const rawQuery = d.query?.text || '—';
    const rawCode = d.response?.code || '—';
    const rawEmbedding = d.query?.embeddingText || '—';
    const rawMatchPrompt = topMatch?.prompt || '—';
    const md = [
      `## RAG Request ${d.requestId}`,
      '',
      `- **Timestamp:** ${ts}`,
      `- **Language:** ${lang}`,
      `- **Model:** ${model}`,
      `- **Success:** ${success}`,
      `- **Latency:** ${latency}`,
      `- **Compile Units:** ${unitsStr}`,
      `- **Input Tokens:** ${inputTokensStr}`,
      `- **Output Tokens:** ${outputTokensStr}`,
      `- **Retries:** ${retries}`,
      '',
      `### User Prompt`,
      '```', rawQuery, '```',
      '',
      ...(rawEmbedding !== rawQuery ? [`### Search Query`, '```', rawEmbedding, '```', ''] : []),
      `### Top Match (similarity: ${matchSim})`,
      '',
      `**Prompt:**`,
      '```', rawMatchPrompt, '```',
      '',
      `### Generated Code`,
      '```', rawCode, '```',
    ].join('\n');
    const mdAttr = escapeHtml(md);

    const summaryRow = `<tr class="${successClass} clickable" onclick="toggle(${i})"><td class="ts">${ts}</td><td>${lang}</td><td class="model">${escapeHtml(model)}</td><td>${query}</td><td>${success}</td><td>${latency}</td><td>${topSim}</td><td>${unitsStr}</td><td>${inputTokensStr}</td><td>${outputTokensStr}</td><td>${retries}</td></tr>`;
    const detailRow = `<tr class="detail-row" id="detail-${i}"><td colspan="11"><div class="detail-panel">
<div class="detail-actions"><button class="copy-btn" onclick="copyMd(this)" data-md="${mdAttr}">Copy</button></div>
<div class="detail-section"><div class="detail-label">User Prompt</div><pre class="detail-pre">${fullQuery}</pre></div>
${embeddingText !== fullQuery ? `<div class="detail-section"><div class="detail-label">Search Query</div><pre class="detail-pre">${embeddingText}</pre></div>` : ''}
<div class="detail-section"><div class="detail-label">Top Match (similarity: ${matchSim})</div>
<div class="detail-sublabel">Prompt</div><pre class="detail-pre">${matchPrompt}</pre>
</div>
<div class="detail-section"><div class="detail-label">Generated Code</div><pre class="detail-pre">${responseCode}</pre></div>
</div></td></tr>`;
    return summaryRow + '\n' + detailRow;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RAG Analytics Report</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; color: #1e293b; padding: 24px; }
  h1 { font-size: 1.5rem; margin-bottom: 4px; }
  .subtitle { color: #64748b; font-size: 0.875rem; margin-bottom: 24px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .card { background: #fff; border-radius: 8px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .card .label { font-size: 0.75rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
  .card .value { font-size: 1.5rem; font-weight: 600; margin-top: 4px; }
  .card .note { font-size: 0.7rem; color: #94a3b8; margin-top: 2px; }
  .section { margin-bottom: 32px; }
  .section h2 { font-size: 1.1rem; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); font-size: 0.85rem; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #e2e8f0; }
  th { background: #f1f5f9; font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #475569; }
  tr.failure td { background: #fef2f2; }
  tr.success td { }
  td.ts { font-family: monospace; font-size: 0.8rem; white-space: nowrap; }
  td.model { font-family: monospace; font-size: 0.8rem; white-space: nowrap; }
  /* Model ids are long and hyphenated; give the card two columns so the common
     single-model case fits on one line, and break at hyphens rather than mid-token. */
  .card.model-card { grid-column: span 2; }
  .self-match { font-size: 0.65rem; color: #b45309; background: #fef3c7; border-radius: 3px; padding: 1px 4px; vertical-align: middle; }
  .model-value { font-size: 1rem; font-weight: 500; overflow-wrap: break-word; word-break: normal; }
  .model-name { font-family: monospace; }
  .model-split { display: flex; justify-content: space-between; gap: 12px; font-size: 0.9rem; line-height: 1.5; }
  .model-share { color: #64748b; font-variant-numeric: tabular-nums; }
  .model-more { color: #94a3b8; font-size: 0.8rem; }
  .empty { color: #94a3b8; text-align: center; padding: 32px; }
  tr.clickable { cursor: pointer; }
  tr.clickable:hover td { background: #f1f5f9; }
  tr.clickable.active td { font-weight: 600; background: #f1f5f9; }
  tr.detail-row { display: none; }
  tr.detail-row.open { display: table-row; }
  .detail-panel { padding: 12px 4px; }
  .detail-section { margin-bottom: 12px; }
  .detail-label { font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #475569; margin-bottom: 4px; }
  .detail-sublabel { font-weight: 600; font-size: 0.7rem; color: #64748b; margin: 8px 0 2px 8px; }
  .detail-pre { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 8px; font-size: 0.8rem; white-space: pre-wrap; word-break: break-word; max-height: 300px; overflow-y: auto; margin-left: 8px; }
  .detail-actions { margin-bottom: 12px; text-align: right; }
  .copy-btn { background: #3b82f6; color: #fff; border: none; border-radius: 4px; padding: 6px 12px; font-size: 0.8rem; cursor: pointer; }
  .copy-btn:hover { background: #2563eb; }
  .copy-btn.copied { background: #22c55e; }
</style>
<script>
function toggle(i) {
  var prev = document.querySelector('tr.detail-row.open');
  var prevSummary = document.querySelector('tr.clickable.active');
  if (prev && prev.id !== 'detail-' + i) {
    prev.classList.remove('open');
    if (prevSummary) prevSummary.classList.remove('active');
  }
  var row = document.getElementById('detail-' + i);
  row.classList.toggle('open');
  row.previousElementSibling.classList.toggle('active');
}
function copyMd(btn) {
  var md = btn.getAttribute('data-md');
  navigator.clipboard.writeText(md).then(function() {
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(function() { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
  });
}
</script>
</head>
<body>
<h1>RAG Analytics Report</h1>
<p class="subtitle">Period: last ${period}${langLabel} | Generated: ${now}</p>

<div class="cards">
  <div class="card"><div class="label">Total Requests</div><div class="value">${metrics.total}</div></div>
  <div class="card"><div class="label">Success Rate</div><div class="value">${(metrics.successRate * 100).toFixed(1)}%</div></div>
  <div class="card model-card"><div class="label">Model</div><div class="value model-value">${modelCard}</div></div>
  <div class="card"><div class="label">Avg Latency</div><div class="value">${Math.round(metrics.avgLatency)}ms</div></div>
  <div class="card"><div class="label" title="One vote per distinct query, self-matches excluded. ${metrics.distinctQueries} distinct queries from ${metrics.similarityRecords} retrievals.">Avg Top Similarity</div><div class="value">${metrics.avgTopSimilarity.toFixed(3)}</div><div class="note">${metrics.distinctQueries} distinct queries${metrics.similarityRecords > 0 ? ` · ${metrics.avgTopSimilarityRaw.toFixed(3)} raw` : ''}</div></div>
  <div class="card"><div class="label" title="Requests whose top match was their own prompt — the corpus contains the query. Excluded from Avg Top Similarity.">Self-Matches</div><div class="value">${metrics.selfMatchCount}</div><div class="note">${metrics.similarityRecords > 0 ? `${((metrics.selfMatchCount / metrics.similarityRecords) * 100).toFixed(0)}% of ${metrics.similarityRecords} retrievals` : '—'}</div></div>
  <div class="card"><div class="label">Compile Units</div><div class="value">${metrics.totalCompileUnits > 0 ? metrics.totalCompileUnits.toLocaleString() : '—'}</div></div>
  <div class="card"><div class="label" title="Uncached input + cache reads + cache writes">Input Tokens</div><div class="value">${metrics.totalInputTokens > 0 ? metrics.totalInputTokens.toLocaleString() : '—'}</div></div>
  <div class="card"><div class="label" title="Share of input tokens served from cache">Cached Input</div><div class="value">${metrics.cacheHitRate != null ? (metrics.cacheHitRate * 100).toFixed(1) + '%' : '—'}</div></div>
  <div class="card"><div class="label">Output Tokens</div><div class="value">${metrics.totalOutputTokens > 0 ? metrics.totalOutputTokens.toLocaleString() : '—'}</div></div>
  <div class="card"><div class="label">Feedback Score</div><div class="value">${metrics.feedbackCount > 0 ? metrics.avgFeedback.toFixed(1) : '—'}</div></div>
  <div class="card"><div class="label">Judge Overall</div><div class="value">${metrics.judgeCount > 0 ? metrics.avgJudgeOverall.toFixed(2) : '—'}</div></div>
</div>

${!language ? `<div class="section">
  <h2>By Language</h2>
  ${metrics.languageBreakdown.length > 0 ? `
  <table>
    <thead><tr><th>Language</th><th>Requests</th><th>Success Rate</th><th>Avg Latency</th><th>Judge (1-5)</th></tr></thead>
    <tbody>${langRows}</tbody>
  </table>` : '<p class="empty">No language data</p>'}
</div>` : ''}

<div class="section">
  <h2>By Model</h2>
  ${metrics.modelBreakdown.length > 0 ? `
  <table>
    <thead><tr><th>Model</th><th>Requests</th><th>Success Rate</th><th>First Pass</th><th>Avg Retries</th><th>Avg Latency</th><th title="Uncached input + cache reads + cache writes">In Tokens (total)</th><th title="Share of input tokens served from cache">Cached</th><th>Out Tokens</th></tr></thead>
    <tbody>${modelRows}</tbody>
  </table>` : '<p class="empty">No model data</p>'}
</div>

<div class="section">
  <h2>Error Breakdown</h2>
  ${metrics.errorBreakdown.length > 0 ? `
  <table>
    <thead><tr><th>Error</th><th>Count</th></tr></thead>
    <tbody>${errorRows}</tbody>
  </table>` : '<p class="empty">No errors recorded</p>'}
</div>

<div class="section">
  <h2>Request Details</h2>
  ${docs.length > 0 ? `
  <div style="overflow-x:auto">
  <table>
    <thead><tr><th>Timestamp</th><th>Language</th><th>Model</th><th>Query</th><th>Success</th><th>Latency</th><th>Top Similarity</th><th>Units</th><th title="Uncached input + cache reads + cache writes">In Tokens</th><th>Out Tokens</th><th>Retries</th></tr></thead>
    <tbody>${detailRows}</tbody>
  </table>
  </div>` : '<p class="empty">No requests in this period</p>'}
</div>

</body>
</html>`;
}

async function main() {
  const { period, output, language } = parseArgs(process.argv);

  console.log(`Fetching RAG analytics for the last ${period}${language ? ` (lang: ${language})` : ''}...`);
  const docs = await fetchDocs(period, language);
  console.log(`Found ${docs.length} records`);

  const usageInfo = await fetchUsageInfo(docs.map(d => d.requestId));
  const metrics = computeMetrics(docs, usageInfo);
  const html = generateHtml(docs, metrics, period, language, usageInfo);

  writeFileSync(output, html, 'utf-8');
  console.log(`Report written to ${output}`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
