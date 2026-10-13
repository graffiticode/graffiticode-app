import bent from "bent";

const apiUrl = process.env.NEXT_PUBLIC_GC_API_URL || "https://api.graffiticode.org";
const getApiString = bent(apiUrl, "GET", "string");
const getApiJSON = bent(apiUrl, "GET", "json");

export const getBaseUrlForApi = () => apiUrl;

// Which languages the current user has a per-user binding override for. Cached
// per token with a short TTL. The local asset caches below key their read/write
// gating on this (NOT on token presence): authenticated users always send a
// token, so gating on the token alone would disable the shared caches for
// everyone. Gating on actual override membership keeps the shared cache for the
// (vast majority of) non-overridden languages while a tester's overridden
// language correctly bypasses it on both read and write.
const OVERRIDE_LANGS_TTL_MS = 2 * 60 * 1000;
const overrideLangsCache = new Map<string, { set: Set<string>; expires: number }>();

// Match the zero-padded "L0175" form used as override-doc keys, so an unpadded
// caller id ("175") still resolves against the override set.
const normalizeLangCode = (lang: string | number) =>
  `L${String(lang).replace(/^L/i, "").padStart(4, "0")}`.toUpperCase();

export const getOverriddenLangs = async (accessToken?: string): Promise<Set<string>> => {
  if (!accessToken) return new Set();
  const cached = overrideLangsCache.get(accessToken);
  if (cached && Date.now() < cached.expires) {
    return cached.set;
  }
  let set = new Set<string>();
  try {
    const { status, data } = await getApiJSON(`/lang-overrides`, null, { Authorization: accessToken });
    if (status === "success" && Array.isArray(data?.langs)) {
      set = new Set(data.langs.map(normalizeLangCode));
    }
  } catch (err) {
    console.warn("Failed to fetch lang overrides:", (err as any)?.message);
  }
  overrideLangsCache.set(accessToken, { set, expires: Date.now() + OVERRIDE_LANGS_TTL_MS });
  return set;
};

// True when the given language is overridden for the token-bearing caller.
export const isLangOverridden = async (lang: string | number, accessToken?: string): Promise<boolean> => {
  if (!accessToken) return false;
  return (await getOverriddenLangs(accessToken)).has(normalizeLangCode(lang));
};

// `accessToken`, when supplied, is forwarded as the Authorization header so the
// API can resolve the caller's uid and apply any per-user language-server
// binding override. Anonymous callers omit it and get the default binding.
export const getLanguageAsset = async (lang, file, accessToken?: string) => {
  try {
    // Bypass the CDN edge cache (api.graffiticode.org serves these with `max-age=3600`) so a
    // language deploy propagates without a manual cache purge. A unique query string forces a
    // cache MISS → fresh origin fetch; the in-memory caches below dedupe so origin load stays low.
    const headers = accessToken ? { Authorization: accessToken } : undefined;
    return await getApiString(`/${lang}/${file}?_cb=${Date.now()}`, null, headers);
  } catch (err) {
    console.warn(`Failed to fetch ${lang}/${file}:`, err.message);
    return null;
  }
};

// Lexicon cache: short TTL so a language deploy (new dimensions/standards/tags) is picked up
// within minutes rather than up to an hour. Origin fetches bypass the CDN (see getLanguageAsset).
const LEXICON_CACHE_TTL_MS = 5 * 60 * 1000;
const lexiconCache = new Map<string, { value: any; expires: number }>();

// Get and parse lexicon for a language. When this language is overridden for the
// caller the fetch is redirected to a test revision, so the shared (lang-keyed)
// cache is bypassed (read and write) to avoid mixing it with the default
// binding. Non-overridden languages keep using the shared cache.
export const getLanguageLexicon = async (lang: string, accessToken?: string) => {
  const overridden = await isLangOverridden(lang, accessToken);
  const cached = !overridden && lexiconCache.get(lang);
  if (cached && Date.now() < cached.expires) {
    return cached.value;
  }

  try {
    const lexiconData = await getLanguageAsset(`L${lang}`, 'lexicon.json', accessToken);
    let lexicon = null;

    if (lexiconData) {
      if (typeof lexiconData === 'string') {
        const lexiconStr = lexiconData.substring(lexiconData.indexOf("{"));
        try {
          lexicon = JSON.parse(lexiconStr);
        } catch (e) {
          console.warn(`Failed to parse lexicon for L${lang}:`, e.message);
        }
      } else {
        lexicon = lexiconData;
      }
    }

    if (lexicon && !overridden) {
      lexiconCache.set(lang, { value: lexicon, expires: Date.now() + LEXICON_CACHE_TTL_MS });
    }
    return lexicon;
  } catch (error) {
    console.warn(`Failed to fetch lexicon for L${lang}:`, error.message);
    return null;
  }
};

// Unparse-hints cache: same short TTL/serving channel as the lexicon (see getLanguageAsset).
const HINTS_CACHE_TTL_MS = 5 * 60 * 1000;
const hintsCache = new Map<string, { value: Record<string, any>; expires: number }>();

// Per-language unparse hints: a map of node tag -> comment (string, or {before,after})
// that the unparser injects as /* */ annotations to orient the spec generator. The asset
// is optional; an absent or unparseable file yields an empty map (plain unparse output).
export const getLanguageHints = async (lang: string, accessToken?: string): Promise<Record<string, any>> => {
  const overridden = await isLangOverridden(lang, accessToken);
  const cached = !overridden && hintsCache.get(lang);
  if (cached && Date.now() < cached.expires) {
    return cached.value;
  }

  let hints: Record<string, any> = {};
  try {
    const data = await getLanguageAsset(`L${lang}`, 'unparse-hints.json', accessToken);
    if (data) {
      const parsed = typeof data === 'string'
        ? JSON.parse(data.substring(data.indexOf("{")))
        : data;
      if (parsed && typeof parsed === 'object') {
        hints = parsed;
      }
    }
  } catch (error) {
    console.warn(`Failed to fetch unparse-hints for L${lang}:`, (error as any).message);
  }

  if (!overridden) {
    hintsCache.set(lang, { value: hints, expires: Date.now() + HINTS_CACHE_TTL_MS });
  }
  return hints;
};

// Spec-directive cache: same short TTL/serving channel as the lexicon/hints.
const SPEC_DIRECTIVE_CACHE_TTL_MS = 5 * 60 * 1000;
const specDirectiveCache = new Map<string, { value: string | null; expires: number }>();

// Per-language get_spec directive: an OPTIONAL markdown asset that overrides the
// global content-oriented SPEC_DIRECTIVE, letting a dialect shape what get_spec
// emits (e.g. a developer "recipe" — goal/preconditions/procedure/acceptance —
// instead of a content description). Absent (404) → null, so the caller falls
// back to the global directive. Backward-compatible: every existing dialect
// ships no spec-directive.md and keeps identical behavior.
export const getLanguageSpecDirective = async (lang: string, accessToken?: string): Promise<string | null> => {
  const overridden = await isLangOverridden(lang, accessToken);
  const cached = !overridden && specDirectiveCache.get(lang);
  if (cached && Date.now() < cached.expires) {
    return cached.value;
  }

  let directive: string | null = null;
  try {
    const data = await getLanguageAsset(`L${lang}`, 'spec-directive.md', accessToken);
    if (typeof data === 'string' && data.trim()) {
      directive = data;
    }
  } catch (error) {
    console.warn(`Failed to fetch spec-directive for L${lang}:`, (error as any).message);
  }

  if (!overridden) {
    specDirectiveCache.set(lang, { value: directive, expires: Date.now() + SPEC_DIRECTIVE_CACHE_TTL_MS });
  }
  return directive;
};

// Standardized message shown when a language service can't be reached.
export const languageOfflineMessage = (lang: string) =>
  `Language L${lang} is offline. Try again later.`;

// Detect exceptions thrown when a language service is unavailable: the
// lexicon.json asset can't be fetched/parsed, or the API connection fails.
export const isLanguageOfflineError = (err: any): boolean => {
  if (!err) return false;
  const message = typeof err === "string" ? err : (err.message || "");
  if (/lexicon|unable to use lexicon|malformed lexicon|offline/i.test(message)) {
    return true;
  }
  const netCodes = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ECONNABORTED/i;
  if (netCodes.test(String(err.code || "")) || netCodes.test(message)) {
    return true;
  }
  const status = typeof err.statusCode === "number" ? err.statusCode
    : (typeof err.status === "number" ? err.status : 0);
  return status >= 500;
};

export const getApiTask = async ({ auth, id }) => {
  try {
    const headers = { "Authorization": auth.token };
    const { status, error, data: task } = await getApiJSON(`/task?id=${id}`, null, headers);
    if (status !== "success") {
      throw new Error(`failed to get task ${id}: ${error.message}`);
    }
    return task;
  } catch (err) {
    throw err;
  }
};

/**
 * A task's COMPILED data — what the dialect's compiler produced, as opposed to `/task`, which
 * returns only `{ lang, code }` (the AST).
 *
 * Same header auth as getApiTask. Returns null rather than throwing on any failure: the only
 * caller is spec generation, where this is enrichment — a spec must still be produced when the
 * data is unavailable, just without whatever the compiler computed.
 */
export const getApiData = async ({ auth, id }) => {
  try {
    const headers = { "Authorization": auth.token };
    const { status, data } = await getApiJSON(`/data?id=${id}`, null, headers);
    if (status !== "success") return null;
    // The compile envelope nests the dialect's own data one level down.
    return (data as any)?.data ?? data ?? null;
  } catch (err) {
    console.warn(`getApiData: could not fetch data for ${id}:`, (err as Error)?.message);
    return null;
  }
};

// With a connection this is an explicit run: the program executes through the
// connection (its writes included) under the invocation the idempotency key
// names, and the gateway stores the result for later views. Send the same key
// when retrying the same run, and a new one for a deliberate rerun.
export const postApiCompile = async ({ accessToken, id, data, connectionId = null, idempotencyKey = null }: {
  accessToken: string; id: string; data: any; connectionId?: string | null; idempotencyKey?: string | null;
}) => {
  try {
    // console.log(
    //   "postApiCompile()",
    //   "id=" + id,
    //   "data=" + JSON.stringify(data, null, 2)
    // );
    const headers = {
      authorization: accessToken,
      "x-graffiticode-storage-type": "persistent",
    };
    const post = bent(apiUrl, "POST", "json", headers);
    const body = connectionId ? { id, data, connectionId, ...(idempotencyKey ? { idempotencyKey } : {}) } : { id, data };
    const resp = await post('/compile', body);
    if (resp.status !== "success") {
      throw new Error(`failed to post compile ${id}: ${resp.status}`);
    }
    // console.log(
    //   "postApiCompile()",
    //   "resp=" + JSON.stringify(resp, null, 2),
    // );
    return resp;
  } catch (x) {
    console.log(
      "postApiCompile()",
      "ERROR",
      x,
    );
    throw x;
  }
};
