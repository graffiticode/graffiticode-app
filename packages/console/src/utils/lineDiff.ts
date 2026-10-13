// Line diff for the transcript's expandable rows.
//
// Hand-rolled rather than a dependency: the inputs are Graffiticode sources —
// tens to a few hundred lines — so a plain LCS table is the whole algorithm.
// This is also what produces the "+N −M lines" summary above the diff, so the
// header can never disagree with the body it expands to.

export type DiffRow =
  | { type: 'ctx' | 'add' | 'del'; text: string }
  | { type: 'gap'; count: number };

export type DiffResult = {
  rows: DiffRow[];
  added: number;
  removed: number;
  /** Too big for an O(N×M) table; callers fall back to a cheaper summary. */
  tooLarge: boolean;
};

// A 2000×2000 table is 4M cells — already past what's worth building
// synchronously, and far past any real source file.
const MAX_DIFF_LINES = 2000;

// Newlines aren't significant in Graffiticode and neither is leading indent, so
// a reflowed line isn't a change. The RAW line is what gets displayed.
const key = (line: string) => line.trim();

// "" is zero lines, not one empty one — otherwise a v1 diffed against the empty
// file reports a phantom removed line.
const splitLines = (s: any) => {
  const text = String(s ?? '');
  return text === '' ? [] : text.split('\n');
};

export function diffLines(before: any, after: any): DiffResult {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return { rows: [], added: 0, removed: 0, tooLarge: true };
  }

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  // Built from the end so the walk below can go forward, which keeps the rows
  // in file order without a reversal.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0)
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = key(a[i]) === key(b[j])
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (key(a[i]) === key(b[j])) {
      // Show the new side's text: a trailing-whitespace-only change is not a
      // diff row, and the row should read as the version being looked at.
      rows.push({ type: 'ctx', text: b[j] });
      i++; j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ type: 'del', text: a[i] });
      removed++;
      i++;
    } else {
      rows.push({ type: 'add', text: b[j] });
      added++;
      j++;
    }
  }
  for (; i < a.length; i++) {
    rows.push({ type: 'del', text: a[i] });
    removed++;
  }
  for (; j < b.length; j++) {
    rows.push({ type: 'add', text: b[j] });
    added++;
  }

  return { rows, added, removed, tooLarge: false };
}

/** "+3 −1 lines", or null when nothing changed. Matches summarizeSrcDiff's shape. */
export function formatDiffSummary({ added, removed }: { added: number; removed: number }) {
  if (!added && !removed) return null;
  const parts = [];
  if (added) parts.push(`+${added}`);
  if (removed) parts.push(`−${removed}`);
  return `${parts.join(' ')} lines`;
}

/**
 * Drop the unchanged bulk: keep `context` lines around every change and replace
 * longer untouched runs with a gap marker. A run only becomes a gap if it would
 * save lines — collapsing 6 lines into "⋯ 1 unchanged line" reads worse than
 * just showing it.
 */
export function collapseContext(rows: DiffRow[], context = 3): DiffRow[] {
  const changed = rows.map(row => row.type === 'add' || row.type === 'del');
  const keep = rows.map((_, index) => (
    changed.slice(Math.max(0, index - context), index + context + 1).some(Boolean)
  ));

  const out: DiffRow[] = [];
  let run = 0;
  for (let index = 0; index <= rows.length; index++) {
    if (index < rows.length && !keep[index]) {
      run++;
      continue;
    }
    if (run > 0) {
      // A gap costs a line of its own, so only collapse runs of 2 or more.
      if (run > 1) out.push({ type: 'gap', count: run });
      else out.push(rows[index - 1]);
      run = 0;
    }
    if (index < rows.length) out.push(rows[index]);
  }
  return out;
}

// Diffs are keyed by the pair of content-addressed taskIds that produced them,
// so a cached result is valid forever. Without this the 8s taskVersions poll
// would re-diff an item's whole history on every revalidation.
const MAX_CACHED_DIFFS = 200;
const diffCache = new Map<string, DiffResult>();

export function cachedDiff(cacheKey: string, before: any, after: any): DiffResult {
  const hit = diffCache.get(cacheKey);
  if (hit) return hit;
  const result = diffLines(before, after);
  diffCache.set(cacheKey, result);
  while (diffCache.size > MAX_CACHED_DIFFS) {
    const oldest = diffCache.keys().next().value;
    if (oldest === undefined) break;
    diffCache.delete(oldest);
  }
  return result;
}
