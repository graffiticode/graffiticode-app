export function isNonEmptyString(str) {
  return (typeof (str) === "string" && str.length > 0);
}

export function isNonNullObject(obj) {
  return (typeof obj === "object" && obj !== null);
}

export function isNonNullNonEmptyObject(obj) {
  return (
    typeof obj === "object" &&
      obj !== null &&
      Object.keys(obj).length > 0
  );
}

// Task ids are long content hashes; show a recognizable middle slice. A compound
// id (a `head+s2+s3` pipeline chain) elides each segment so the shape stays visible.
export function elideTaskId(id) {
  return (id && id.length > 25 ? id.substring(17, 25) : id || '');
}

export function elideCompoundId(id) {
  if (!id) return '';
  if (!id.includes('+')) return elideTaskId(id);
  return id.split('+').map(elideTaskId).join('+');
}

// Cheap line-count delta for labeling a hand edit's version record — a multiset
// compare, not an LCS diff, so a moved line counts as neither added nor removed.
// Returns null when nothing changed, so callers can skip the label entirely.
export function summarizeSrcDiff(before, after) {
  const lines = (s) => String(s || '').split('\n').map(l => l.trim()).filter(Boolean);
  const counts = new Map();
  for (const line of lines(before)) {
    counts.set(line, (counts.get(line) || 0) + 1);
  }
  let added = 0;
  for (const line of lines(after)) {
    const n = counts.get(line) || 0;
    if (n > 0) counts.set(line, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of counts.values()) removed += n;
  if (!added && !removed) return null;
  const parts = [];
  if (added) parts.push(`+${added}`);
  if (removed) parts.push(`−${removed}`);
  return `${parts.join(' ')} lines`;
}
