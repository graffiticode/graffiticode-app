// Tiny localStorage cache for the items nav list so it paints instantly on
// reload before the network fetch returns. Keyed by the SWR key; stores only
// the metadata array returned by loadItems (no code/source).
//
// Bounded on purpose: this is a paint-ahead cache, not a data store. Each entry
// is capped to MAX_ITEMS (enough to fill the first screen) and we keep at most
// MAX_KEYS entries (LRU). Without these caps the cache grew unbounded — one
// entry per uid/lang/mark/client combo, never evicted — and saturated the
// origin's ~5-10MB localStorage quota, which then broke unrelated writes
// (e.g. Privy's sign-in state on /claim) with QuotaExceededError.

const PREFIX = "graffiticode:items:";
const LRU_KEY = PREFIX + "__lru";
const VERSION = 1;
const MAX_ITEMS = 100;
const MAX_KEYS = 8;

function readLru(): string[] {
  try {
    const raw = window.localStorage.getItem(LRU_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLru(order: string[]): void {
  try {
    window.localStorage.setItem(LRU_KEY, JSON.stringify(order));
  } catch {
    /* ignore */
  }
}

// Drop every items-cache entry (keeps other graffiticode:* keys). Used as the
// last-ditch recovery when a write hits the quota.
function clearAll(): void {
  const keys: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (k && k.startsWith(PREFIX)) keys.push(k);
  }
  keys.forEach((k) => window.localStorage.removeItem(k));
}

export function readItemsCache(key: string | null): any[] | undefined {
  if (!key || typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    if (parsed?.v !== VERSION || !Array.isArray(parsed.items)) return undefined;
    return parsed.items;
  } catch {
    return undefined;
  }
}

export function writeItemsCache(key: string | null, items: any[]): void {
  if (!key || typeof window === "undefined") return;
  const storageKey = PREFIX + key;
  const payload = JSON.stringify({ v: VERSION, items: items.slice(0, MAX_ITEMS) });

  // Promote this key to most-recently-used and evict anything past MAX_KEYS.
  const order = [key, ...readLru().filter((k) => k !== key)];
  const evicted = order.splice(MAX_KEYS);
  evicted.forEach((k) => window.localStorage.removeItem(PREFIX + k));

  try {
    window.localStorage.setItem(storageKey, payload);
    writeLru(order);
  } catch {
    // Quota hit despite the caps (origin filled by something else). Clear the
    // whole items cache and retry once; give up quietly if it still fails.
    try {
      clearAll();
      window.localStorage.setItem(storageKey, payload);
      writeLru([key]);
    } catch {
      /* ignore — paint-ahead is best-effort */
    }
  }
}
