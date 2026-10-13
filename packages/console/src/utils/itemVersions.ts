// Merge an item's chat transcript with its recorded version history.
//
// The help array is the conversation record: after a generation, the resulting
// taskId is grafted onto the user's prompt bubble, so a prompt doubles as the
// handle for the version it produced. Anything that mints a taskId WITHOUT a
// prompt — a direct code edit, an MCP edit, a claimed/shared item's v1 — has no
// bubble and was invisible in the items view.
//
// users/{uid}/versions is the server's complete record of every content state
// (see recordVersion() in src/pages/api/resolvers.ts). Joining the two on taskId
// gives one timeline: matched versions keep rendering as their prompt bubble,
// unmatched ones become their own rows. Nothing is written back into help —
// that array is also the LLM's conversation context.

import { isNonNullObject, summarizeSrcDiff } from './index';
import { cachedDiff, formatDiffSummary } from './lineDiff';

// Newest N versions of an item the transcript asks for. The server caps at 1000;
// 200 is plenty of scrollback and keeps the per-item poll cheap. Lives here so
// the merge can tell a complete history from a truncated page of one.
export const ITEM_VERSIONS_LIMIT = 200;

// The eight VersionSource values (src/pages/api/resolvers.ts). The server clamps
// `source` to this set and defaults nulls to "unknown", so the fallbacks below
// are belt-and-braces.
// "unknown" is what a plain create records — a new item, a copied item, the
// /editor page's create — since defaultVersionSource() only ever recognizes mcp.
// So it reads as "New".
export const VERSION_SOURCE_LABELS = {
  'chat': 'Chat',
  'generation-job': 'Generated',
  // "Human" vs "Agent": the chip answers who made the change, not which screen
  // it was made on.
  'editor': 'Human',
  'mcp': 'Agent',
  'claim': 'Claimed',
  'share': 'Shared',
  'backfill': 'History',
  'unknown': 'New',
};

export const versionSourceLabel = (source) => VERSION_SOURCE_LABELS[source] || 'New';

// Help entries carry an ISO timestamp, version records an epoch-ms number as a
// string, and the oldest help entries an epoch-ms string. Normalize all three.
export const toEpochMs = (ts) => {
  if (ts === null || ts === undefined) return null;
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null;
  const s = String(ts).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : null;
};

const isRenderableHelpEntry = (msg) => (
  isNonNullObject(msg) && (msg.type === 'user' || msg.role === 'system')
);

const kindRank = (row) => (row.kind === 'help' ? 0 : 1);

/**
 * Build the newest-first row list the Help panel renders.
 *
 * @param help      parsed help array (chat transcript)
 * @param versions  taskVersions rows for this item, newest-first
 * @param itemId    the open item; versions for any other item are dropped
 * @param srcByTaskId  source text per taskId (useVersionSrc); the rows it covers
 *                     get a "+N −M lines" stat instead of a bare task id
 * @param collapseWindowMs  fold runs of consecutive hand edits closer together
 *                          than this into one row. 0 (default) disables it.
 */
export const buildTranscriptRows = ({ help, versions, itemId, srcByTaskId, collapseWindowMs = 0 }: {
  help?: any[];
  versions?: any[];
  itemId?: string;
  srcByTaskId?: Map<string, string>;
  collapseWindowMs?: number;
}) => {
  const helpEntries = Array.isArray(help) ? help : [];
  const versionRows = Array.isArray(versions) ? versions : [];

  // 1. Help rows, carrying the array index so the renderer keeps its existing
  // index-based delete/pending logic without an O(n^2) indexOf per message.
  const rows = [];
  let lastTs = null;
  helpEntries.forEach((message, index) => {
    if (!isRenderableHelpEntry(message)) return;
    let ts = toEpochMs(message.timestamp);
    let tsInferred = false;
    if (ts === null) {
      // Old entries predate timestamps. Anchor them to their chronological
      // neighbour so they stay in place instead of sinking to the bottom.
      ts = lastTs ?? 0;
      tsInferred = true;
    } else {
      lastTs = ts;
    }
    rows.push({ kind: 'help', index, message, taskId: message.taskId || null, ts, tsInferred });
  });

  // 2. Index versions by taskId. On a duplicate, keep the OLDEST: reverting
  // re-derives the same content-addressed taskId and recordVersion preserves the
  // original createdAt, so the earlier row is the canonical one.
  const versionsByTaskId = new Map();
  for (const version of versionRows) {
    if (!isNonNullObject(version) || !version.taskId) continue;
    if (itemId && version.itemId !== itemId) continue;
    const existing = versionsByTaskId.get(version.taskId);
    if (!existing || (toEpochMs(version.createdAt) ?? 0) < (toEpochMs(existing.createdAt) ?? 0)) {
      versionsByTaskId.set(version.taskId, version);
    }
  }

  // 3. Join. Exact full-chain equality only — `head+A` and `head+B` are
  // genuinely different versions, so no head-segment fallback.
  const matched = new Set();
  for (const row of rows) {
    if (!row.taskId) continue;
    const version = versionsByTaskId.get(row.taskId);
    if (version) {
      row.version = version;
      matched.add(row.taskId);
    }
  }

  // 4. Every version with no bubble of its own becomes a row.
  for (const [taskId, version] of versionsByTaskId) {
    if (matched.has(taskId)) continue;
    rows.push({
      kind: 'version',
      version,
      taskId,
      ts: toEpochMs(version.createdAt) ?? 0,
      // The Firestore doc id ({itemId}__{taskId}) — stable and unique.
      key: version.id || `${version.itemId}__${taskId}`,
    });
  }

  // 5. What each version changed. Both row kinds get it: a matched version
  // renders as its prompt bubble, and that bubble should still report the
  // delta it produced.
  const statsByTaskId = computeVersionStats(versionsByTaskId, srcByTaskId);
  for (const row of rows) {
    const stat = row.taskId && statsByTaskId.get(row.taskId);
    if (!stat) continue;
    row.stats = stat.summary;
    // Set only when the pair is diffable, so the renderer can offer an expand
    // toggle exactly when there is something to expand into.
    if (stat.diffKey) {
      row.diffKey = stat.diffKey;
      row.diffBase = stat.diffBase;
    }
  }

  // 6. Newest first. Fully deterministic: never rely on sort stability.
  rows.sort((a, b) => (
    (b.ts - a.ts) ||
    (kindRank(a) - kindRank(b)) ||
    ((b.index ?? -1) - (a.index ?? -1)) ||
    String(a.key ?? a.index).localeCompare(String(b.key ?? b.index))
  ));

  const collapsed = collapseWindowMs > 0 ? collapseEditRuns(rows, collapseWindowMs) : rows;
  return { rows: collapsed, versionCount: versionsByTaskId.size };
};

// A "+N −M lines" label per version, diffed against the version before it,
// plus the handle the renderer needs to expand that same diff.
//
// The predecessor is the previous version in TIME, not the previous transcript
// row: help rows without a version of their own sit between them, and a row's
// delta is only meaningful against the content state it replaced.
//
// Two versions get no stat: one whose source (or its predecessor's) hasn't been
// fetched, and the oldest one when the history came back truncated — its
// predecessor is off the page, so crediting it with the whole file would be a
// lie. A genuine v1 does get the whole file, which is what it added.
function computeVersionStats(versionsByTaskId, srcByTaskId) {
  const stats = new Map();
  if (!srcByTaskId || srcByTaskId.size === 0) return stats;

  const ordered = [...versionsByTaskId.values()].sort(
    (a, b) => (toEpochMs(a.createdAt) ?? 0) - (toEpochMs(b.createdAt) ?? 0)
  );
  const truncated = ordered.length >= ITEM_VERSIONS_LIMIT;

  // "" is a real base — the empty file a genuine v1 was added to. null means
  // there is no base to diff against.
  let prevSrc = truncated ? null : '';
  let prevTaskId = '';
  for (const version of ordered) {
    const src = srcByTaskId.get(version.taskId);
    if (src === undefined) {
      // Unknown content: the next version can't be diffed against it either.
      prevSrc = null;
      continue;
    }
    if (prevSrc !== null) {
      // The taskId pair identifies the diff — both sides are content-addressed,
      // so the cache entry is valid for as long as the tab lives.
      const diffKey = `${prevTaskId}->${version.taskId}`;
      const diff = cachedDiff(diffKey, prevSrc, src);
      const summary = diff.tooLarge
        ? summarizeSrcDiff(prevSrc, src)
        : formatDiffSummary(diff);
      if (summary) {
        // No diffKey when it's too large to diff: the row keeps its delta and
        // simply doesn't offer an expand toggle.
        stats.set(version.taskId, diff.tooLarge
          ? { summary }
          : { summary, diffKey, diffBase: prevTaskId });
      }
    }
    prevSrc = src;
    prevTaskId = version.taskId;
  }
  return stats;
}

// Every debounced keystroke burst can mint a version. Folding adjacent hand
// edits keeps the transcript readable when someone types through the editor.
function collapseEditRuns(rows, windowMs) {
  const out = [];
  for (const row of rows) {
    const prev = out[out.length - 1];
    const isEdit = row.kind === 'version' && row.version?.source === 'editor';
    const prevIsEdit = prev && prev.kind === 'version' && prev.version?.source === 'editor';
    if (isEdit && prevIsEdit && Math.abs(prev.ts - row.ts) <= windowMs) {
      // Keep the newest of the run (it is the current content) and count the rest.
      prev.collapsedCount = (prev.collapsedCount || 1) + 1;
      continue;
    }
    out.push(row);
  }
  return out;
}
