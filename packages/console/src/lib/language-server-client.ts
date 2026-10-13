/**
 * Language server client
 *
 * Fetches per-language documentation (language-info.json + usage-guide.md)
 * from each language's Express server (e.g. l0158.graffiticode.org) and
 * caches the result in-memory with a TTL.
 *
 * The console merges this data into the GraphQL `LanguageInfo` resolver so
 * the MCP server can surface the inline envelope + full markdown guide.
 */

export interface LanguageInfoEnvelope {
  id: string;
  description?: string;
  supported_item_types?: string[];
  example_prompts?: Array<{ prompt: string; produces?: string; notes?: string }>;
  authoring_guide?: string;
}

export interface LanguageServerDoc {
  envelope: LanguageInfoEnvelope | null;
  usageGuide: string | null;
}

export interface LanguageScope {
  id: string;
  summary: string;
  in_scope: string[];
  out_of_scope: string[];
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const FAILURE_TTL_MS = 30 * 1000;

const cacheTtlMs = (() => {
  const raw = process.env.LANGUAGE_SERVER_CACHE_TTL_MS;
  if (!raw) return DEFAULT_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
})();

const cache = new Map<string, { value: LanguageServerDoc; expires: number }>();
const scopeCache = new Map<string, { value: LanguageScope | null; expires: number }>();

// One in-flight refresh per language, so a burst cannot stampede the origin.
// listLanguages({enrich:true}) asks for every language at once, so without this a
// cold cache means N concurrent identical fetches per language.
const docInflight = new Map<string, Promise<LanguageServerDoc>>();
const scopeInflight = new Map<string, Promise<LanguageScope | null>>();

/**
 * Stale-while-revalidate for the per-language assets.
 *
 * These are read on the routing path: classifyAndRoute() runs on every MCP create
 * (the scope gate — console generations carry src and skip it) and enriches the
 * whole catalog first. With a plain TTL cache, the first routed create after any
 * 5-minute lull paid a full cold fan-out; measured route_ms was ~3.0s warm and
 * ~11.7s cold, and the cold case recurs by construction — every TTL expiry, every
 * new instance, every deploy.
 *
 * So: a stale value answers immediately and the refresh happens behind it. The
 * cold path (nothing cached at all) still waits, because there is nothing else to
 * serve. Freshness is unchanged in the sense that matters — scope.json changes on
 * a language deploy, not minute to minute, and being one TTL behind on routing
 * text is invisible next to an 8s stall.
 *
 * A failed refresh NEVER replaces a good value; it re-arms on the short failure
 * TTL so a sick language server is retried soon without discarding what works.
 */
function staleWhileRevalidate<T>(
  store: Map<string, { value: T; expires: number }>,
  inflight: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
  isGood: (value: T) => boolean,
): Promise<T> {
  const cached = store.get(key);
  if (cached && Date.now() < cached.expires) return Promise.resolve(cached.value);

  let refresh = inflight.get(key);
  if (!refresh) {
    refresh = load()
      .then((value) => {
        // Don't let a failed fetch evict a good value — keep the good one and try
        // again on the short TTL.
        if (!isGood(value) && cached && isGood(cached.value)) {
          store.set(key, { value: cached.value, expires: Date.now() + FAILURE_TTL_MS });
          return cached.value;
        }
        store.set(key, {
          value,
          expires: Date.now() + (isGood(value) ? cacheTtlMs : FAILURE_TTL_MS),
        });
        return value;
      })
      .catch((err) => {
        if (cached) {
          store.set(key, { value: cached.value, expires: Date.now() + FAILURE_TTL_MS });
          return cached.value;
        }
        throw err;
      })
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, refresh);
  }

  // Stale answer now; the refresh above lands for the next caller.
  if (cached) return Promise.resolve(cached.value);
  return refresh;
}

import { isLangOverridden } from "./api";

const apiUrl = process.env.NEXT_PUBLIC_GC_API_URL || "https://api.graffiticode.org";

// Build the URL for a language resource. By default these route through the API
// gateway (`${apiUrl}/L<id>/<file>`) so a per-user language-server binding
// override (resolved server-side from the caller's token) can apply. The
// LANGUAGE_SERVER_BASE_URL escape hatch still points directly at a single
// language server for local development (the override does not apply there).
function assetUrlFor(langId: string, file: string): string {
  const override = process.env.LANGUAGE_SERVER_BASE_URL;
  if (override) {
    return `${override.replace(/\/+$/, "")}/${file}`;
  }
  return `${apiUrl}/L${langId}/${file}`;
}

async function fetchText(url: string, accessToken?: string): Promise<string | null> {
  try {
    // Bypass the CDN edge cache, as getLanguageAsset (src/lib/api.ts) does: api.graffiticode.org
    // serves these with `max-age=3600`, so without a unique query string a language's new
    // scope.json reached the scope gate up to an hour after its deploy. On 2026-10-04 the gate
    // kept re-routing L0184 chart-from-URL requests to L0185 off a scope.json that said L0184
    // could not fetch, 48 minutes after that line was removed. The in-memory caches here keep
    // origin load low.
    const busted = `${url}${url.includes("?") ? "&" : "?"}_cb=${Date.now()}`;
    const res = await fetch(busted, accessToken ? { headers: { Authorization: accessToken } } : undefined);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function loadLanguageServerDoc(langId: string, accessToken?: string): Promise<LanguageServerDoc> {
  // Prefer the canonical `usage-guide.md`; fall back to the legacy
  // `user-guide.md` name for languages that haven't been renamed yet.
  const [envelopeRaw, usageGuideRaw] = await Promise.all([
    fetchText(assetUrlFor(langId, "language-info.json"), accessToken),
    fetchText(assetUrlFor(langId, "usage-guide.md"), accessToken)
      .then((s) => s ?? fetchText(assetUrlFor(langId, "user-guide.md"), accessToken)),
  ]);

  let envelope: LanguageInfoEnvelope | null = null;
  if (envelopeRaw) {
    try {
      envelope = JSON.parse(envelopeRaw) as LanguageInfoEnvelope;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`language-server-client: invalid JSON from L${langId} language-info.json: ${message}`);
      envelope = null;
    }
  }

  const doc: LanguageServerDoc = { envelope, usageGuide: usageGuideRaw };
  if (envelope === null && usageGuideRaw === null) {
    console.warn(`language-server-client: could not fetch docs for L${langId}`);
  }
  return doc;
}

export async function getLanguageServerDoc(langId: string, accessToken?: string): Promise<LanguageServerDoc> {
  // See getLanguageScope: an overridden language bypasses the shared cache entirely.
  const overridden = await isLangOverridden(langId, accessToken);
  if (overridden) return loadLanguageServerDoc(langId, accessToken);

  return staleWhileRevalidate(
    cache,
    docInflight,
    langId,
    () => loadLanguageServerDoc(langId, accessToken),
    (value) => value.envelope !== null || value.usageGuide !== null,
  );
}

export function clearLanguageServerCache(langId?: string): void {
  if (langId) {
    cache.delete(langId);
    scopeCache.delete(langId);
  } else {
    cache.clear();
    scopeCache.clear();
  }
}

// Fetches a language's scope.json — the routing-only descriptor served at
// ${base}/scope.json. Cached separately from the heavier envelope+guide so
// the router and catalog can poll it cheaply. Returns null when the file
// is unavailable or malformed; callers should fall back to a static seed.
async function loadLanguageScope(langId: string, accessToken?: string): Promise<LanguageScope | null> {
  const raw = await fetchText(assetUrlFor(langId, "scope.json"), accessToken);

  let scope: LanguageScope | null = null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && typeof parsed.summary === "string") {
        scope = {
          id: String(parsed.id ?? langId),
          summary: String(parsed.summary),
          in_scope: Array.isArray(parsed.in_scope) ? parsed.in_scope.map(String) : [],
          out_of_scope: Array.isArray(parsed.out_of_scope) ? parsed.out_of_scope.map(String) : [],
        };
      } else {
        console.warn(`language-server-client: L${langId} scope.json missing required fields`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`language-server-client: invalid JSON from L${langId} scope.json: ${message}`);
    }
  }
  return scope;
}

export async function getLanguageScope(langId: string, accessToken?: string): Promise<LanguageScope | null> {
  // An overridden language is pinned to a test revision for THIS caller, so it must
  // never read from or write to the shared cache — and must never be served stale.
  const overridden = await isLangOverridden(langId, accessToken);
  if (overridden) return loadLanguageScope(langId, accessToken);

  return staleWhileRevalidate(
    scopeCache,
    scopeInflight,
    langId,
    () => loadLanguageScope(langId, accessToken),
    (value) => value !== null,
  );
}
