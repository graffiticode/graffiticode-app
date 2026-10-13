/**
 * Graffiticode GraphQL API client
 */

import { AsyncLocalStorage } from "async_hooks";
import { FreePlanLimitError, parseFreePlanError, parseFreePlanErrorBody } from "./free-plan-limit.js";

const CONSOLE_API_URL = process.env.GRAFFITICODE_CONSOLE_URL || "https://console.graffiticode.org/api";

// Graffiticode API host. Serves language templates.
export const API_URL = process.env.GRAFFITICODE_API_URL || "https://api.graffiticode.org";

// Bare-host URLs used to construct user-facing links (claim_url, view_url)
// surfaced on trial-mode tool responses. Distinct from CONSOLE_API_URL above,
// which already ends in /api.
export const CONSOLE_URL = process.env.GRAFFITICODE_CONSOLE_BASE_URL || "https://console.graffiticode.org";
export const APP_URL = process.env.GRAFFITICODE_APP_URL || "https://app.graffiticode.org";

// This server's own public MCP endpoint, quoted verbatim in the connect instructions
// we hand users. server.ts and oauth/handlers.ts each hold their own MCP_SERVER_URL
// copy; this reads the same env var so all three agree on the address we publish.
export const MCP_ENDPOINT = `${process.env.MCP_SERVER_URL || "https://mcp.graffiticode.org"}/mcp`;

export type AuthContext =
  // `source` records how the bearer was resolved (see server.ts resolveBearer):
  // "oauth" — already a Firebase ID token; "raw" — the caller's raw Graffiticode
  // API key (forwarded verbatim to the console, which exchanges it).
  | { type: "firebase"; token: string; source?: "oauth" | "raw" }
  // sessionId is whatever we currently present as X-Free-Plan-Session: initially
  // the transport session uuid, and after the console hands one back, a signed
  // workspace token. onWorkspace lets a response rebind it, which is how a
  // client keeps working in one workspace across the transport sessions it keeps
  // losing (restart, scale-out, ChatGPT's per-tool-call sessions).
  | {
      type: "freePlan";
      sessionId: string;
      onWorkspace?: (token: string) => void;
      /**
       * The workspace this call actually resolved to, as the console reported it.
       *
       * Set by the api layer once a mutation answers, and read by the funnel
       * instrumentation so `session` names the workspace rather than the
       * transport. Per-call by construction: getAuth() builds a fresh context
       * for every invocation, so this cannot leak between calls the way the
       * transport-scoped `onWorkspace` binding does.
       */
      effectiveNamespace?: string;
    };

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

function buildAuthHeaders(auth: AuthContext): Record<string, string> {
  if (auth.type === "firebase") {
    return { Authorization: auth.token };
  }
  return { "X-Free-Plan-Session": auth.sessionId };
}

/**
 * Per-request upstream timing, for the funnel's latency breakdown.
 *
 * Every organic ChatGPT arrival pays 12-20s on its FIRST tool call and ~300ms
 * on every call after (measured 7/7 visits, 2026-08-24), and the total `ms` on
 * an event cannot say whether that is spent resolving auth, waiting on the
 * console, or in our own code. This splits it.
 *
 * AsyncLocalStorage rather than a module-level counter because requests
 * interleave — a shared mutable would bill one caller's wait to whoever
 * happened to finish next. Rather than a threaded parameter because the
 * alternative is touching every api.ts signature and every call site to carry
 * a stopwatch.
 *
 * Absent outside a tool call (resources, OAuth), where nothing is accumulating
 * and `record` is a no-op.
 */
export interface UpstreamTiming { ms: number; calls: number }
const upstreamStore = new AsyncLocalStorage<UpstreamTiming>();

/** Run `fn` with a fresh upstream accumulator and hand back what it collected. */
export async function withUpstreamTiming<T>(
  fn: () => Promise<T>
): Promise<{ result: T; timing: UpstreamTiming }> {
  const timing: UpstreamTiming = { ms: 0, calls: 0 };
  const result = await upstreamStore.run(timing, fn);
  return { result, timing };
}

/** Bill elapsed wall-time to the in-flight tool call, if there is one. */
function recordUpstream(startedAt: number): void {
  const t = upstreamStore.getStore();
  if (!t) return;
  t.ms += Date.now() - startedAt;
  t.calls += 1;
}

/**
 * @param opts.timeoutMs Abort the request after this many ms. OMIT IT unless the
 *   caller has a fallback for the failure. There is deliberately NO default: this
 *   function also carries `create_item`/`update_item` generation, which legitimately
 *   runs 60-110s, and `render_item`'s long-poll. A blanket deadline here would break
 *   authoring to protect discovery. Only listLanguages() passes it today, because
 *   only listLanguages() can answer a timeout with a cached catalog.
 */
async function graphqlRequest<T>(
  auth: AuthContext,
  query: string,
  variables: Record<string, unknown>,
  opts?: { timeoutMs?: number }
): Promise<T> {
  const startedAt = Date.now();

  // The timeout must cover the ENTIRE operation — fetch, headers, AND body
  // reading. AbortSignal.timeout on fetch alone left response.json() without
  // a deadline: if the console sent headers but hung mid-body, that await
  // blocked forever. Since listLanguages deduplicates with an inflight map,
  // one stuck fetch poisoned the map and blocked ALL subsequent calls on that
  // instance — a total outage for list_languages while other tools worked.
  const controller = opts?.timeoutMs ? new AbortController() : null;
  const timeout = controller
    ? setTimeout(() => controller.abort(new Error("Request timed out")), opts!.timeoutMs)
    : null;

  try {
    const response = await fetch(CONSOLE_API_URL, {
      method: "POST",
      headers: {
        ...buildAuthHeaders(auth),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      ...(controller ? { signal: controller.signal } : {}),
    });

    // recordUpstream after fetch completes (even on body-read failure)
    recordUpstream(startedAt);

    if (!response.ok) {
      const error = await response.text();
      // A free-plan refusal from the request gate (e.g. the API burst guard)
      // comes back as a non-2xx JSON body; surface it typed, not as a blob.
      throw parseFreePlanErrorBody(error) ?? new Error(`GraphQL request failed: ${error}`);
    }

    const result = await response.json() as GraphQLResponse<T>;

    if (result.errors && result.errors.length > 0) {
      // Quota and generation-burst refusals inside resolvers carry the same
      // payload on the error's extensions.
      for (const e of result.errors) {
        const limit = parseFreePlanError(e.extensions, e.message);
        if (limit) throw limit;
      }
      throw new Error(`GraphQL error: ${result.errors[0].message}`);
    }

    if (!result.data) {
      throw new Error("No data returned from GraphQL");
    }

    return result.data;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// --- Generate Code ---

interface GenerateCodeResult {
  src: string;
  taskId: string;
  description: string | null;
  changeSummary: string | null;
  language: string;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  errors?: Array<{ message: string }>;
}

export async function generateCode(options: {
  auth: AuthContext;
  prompt: string;
  language: string;
  currentSrc?: string;
  itemId?: string;
}): Promise<GenerateCodeResult> {
  const { auth, prompt, language, currentSrc, itemId } = options;

  const query = `
    mutation GenerateCode($prompt: String!, $language: String!, $currentSrc: String, $itemId: String) {
      generateCode(prompt: $prompt, language: $language, currentSrc: $currentSrc, itemId: $itemId) {
        src
        taskId
        description
        changeSummary
        language
        model
        usage {
          input_tokens
          output_tokens
        }
        errors {
          message
        }
      }
    }
  `;

  const result = await graphqlRequest<{ generateCode: GenerateCodeResult }>(
    auth,
    query,
    { prompt, language, currentSrc, itemId }
  );

  return result.generateCode;
}

// Start async generation: the console marks the item "generating", enqueues a
// Cloud Task to run the (60-110s) generation, and returns immediately. Pass an
// existing itemId to update, or omit it to create a new shell item (the server
// returns its id). Poll get_item until generationStatus flips to ready/failed.
export interface GenerationJobResult {
  itemId: string;
  status: string;
  /**
   * The workspace the item actually landed in, free-plan only. The same sha256
   * namespace the funnel logs — not a credential, since the console only accepts
   * a *signed* session token — so it is safe to read and log. Tells us whether a
   * `siblingOf` hint was honoured.
   */
  workspaceNamespace?: string | null;
}

export async function startCodeGeneration(options: {
  auth: AuthContext;
  itemId?: string;
  /**
   * A previous item from the same conversation. Free-plan only: the console
   * adopts that item's workspace, so this create lands beside it instead of
   * opening a new one.
   *
   * This is what keeps a stateless client's items together. A host that mints a
   * fresh MCP session per tool call (ChatGPT) presents a new session namespace
   * every call, and a create — naming no item — has nothing for the console to
   * rebind onto, so each item used to open its own workspace and needed its own
   * claim link. Ignored for authenticated callers, who have a durable identity.
   *
   * REQUIRES the console to declare `siblingOf` on the startCodeGeneration
   * mutation. A variable the schema doesn't accept fails GraphQL validation
   * outright, so the console must deploy first — same rule as `clientKind`.
   */
  siblingOf?: string;
  lang: string;
  name?: string;
  client?: string;
  /**
   * The agent software making the call, e.g. "claude-code". Distinct from
   * `client`, which the console reads app-wide as the item SOURCE SURFACE
   * (console|mcp|front) — reusing that name for this taxonomy would collide.
   * Feeds the console's workspace registry, which records the client kind of a
   * workspace's first create attempt.
   *
   * REQUIRES the console to declare `clientKind` on the startCodeGeneration
   * mutation. A variable the schema doesn't accept fails GraphQL validation
   * outright, so the console must deploy first.
   */
  clientKind?: string;
  /**
   * Coarse country from our edge. Forwarded rather than derived console-side:
   * this hop is a server-to-server fetch from Cloud Run, so the console would
   * otherwise record our own egress region for every MCP-originated item.
   */
  geoCountry?: string;
  prompt: string;
  modification: string;
  currentSrc?: string | null;
  /**
   * What `currentSrc` COMPILES TO, serialized — the values an edit acts on when
   * the program does not carry them itself.
   *
   * REQUIRES the console to declare `currentData` on the startCodeGeneration
   * mutation. A variable the schema doesn't accept fails GraphQL validation
   * outright, so the console must deploy first — same rule as `clientKind`.
   */
  currentData?: string | null;
}): Promise<GenerationJobResult> {
  const { auth, itemId, siblingOf, lang, name, client, clientKind, geoCountry, prompt, modification, currentSrc, currentData } = options;

  const mutation = `
    mutation StartCodeGeneration($itemId: String, $siblingOf: String, $lang: String!, $name: String, $client: String, $clientKind: String, $geoCountry: String, $prompt: String!, $modification: String!, $currentSrc: String, $currentData: String) {
      startCodeGeneration(itemId: $itemId, siblingOf: $siblingOf, lang: $lang, name: $name, client: $client, clientKind: $clientKind, geoCountry: $geoCountry, prompt: $prompt, modification: $modification, currentSrc: $currentSrc, currentData: $currentData) {
        itemId
        status
        workspaceNamespace
      }
    }
  `;

  const result = await graphqlRequest<{ startCodeGeneration: GenerationJobResult }>(
    auth,
    mutation,
    { itemId, siblingOf, lang, name, client, clientKind, geoCountry, prompt, modification, currentSrc, currentData }
  );

  captureWorkspaceNamespace(auth, result.startCodeGeneration);
  return result.startCodeGeneration;
}

// --- Get Data ---

export async function getData(options: {
  auth: AuthContext;
  taskId: string;
  /** Optional deadline, for callers that owe an answer within a fixed budget. */
  timeoutMs?: number;
}): Promise<unknown> {
  const { auth, taskId, timeoutMs } = options;

  const query = `
    query GetData($id: String!) {
      data(id: $id)
    }
  `;

  const result = await graphqlRequest<{ data: string }>(
    auth,
    query,
    { id: taskId },
    timeoutMs ? { timeoutMs } : undefined
  );

  return JSON.parse(result.data);
}

// --- Get Task ---

export async function getTask(options: {
  auth: AuthContext;
  id: string;
}): Promise<{ id: string; lang: string; code: string; src: string }> {
  const { auth, id } = options;

  const query = `
    query GetTask($id: String!) {
      task(id: $id) {
        id
        lang
        code
        src
      }
    }
  `;

  const result = await graphqlRequest<{ task: { id: string; lang: string; code: string; src: string } }>(
    auth,
    query,
    { id }
  );

  return result.task;
}

// --- Item CRUD ---

export interface Item {
  id: string;
  name: string | null;
  taskId: string | null;
  lang: string;
  help: string | null;
  isPublic: boolean;
  created: string;
  updated: string;
  client: string | null;
  // Async-generation status. Absent/null ⇒ legacy/ready.
  generationStatus?: "generating" | "ready" | "failed" | null;
  generationError?: string | null;
  generationStartedAt?: string | null;
  // Characters a RUNNING generation has emitted so far, published by the console
  // every ~2s. Null once terminal. Characters rather than tokens because that is
  // what streams — Anthropic reports output_tokens only at the end of a turn.
  generationChars?: number | null;
  // Free-plan only, minted by the console from the item's EFFECTIVE workspace.
  // `workspace` is presented on later requests; `claimToken` builds claim links.
  // Never populated for authenticated callers.
  workspace?: string | null;
  claimToken?: string | null;
}

/**
 * Adopt a workspace handle the console returned. The console decides the
 * workspace (it may rebind ours to the one an item already belongs to), so its
 * answer is authoritative and we just carry it forward.
 */
export function captureWorkspace(auth: AuthContext, item: { workspace?: string | null } | null): void {
  if (!item?.workspace || auth.type !== "freePlan") return;
  auth.onWorkspace?.(item.workspace);
}

/**
 * Record which workspace a call actually landed in, for the funnel only.
 *
 * Distinct from captureWorkspace: that carries a signed TOKEN forward so the next
 * request stays in the workspace, and only works while the transport lives. This
 * carries the plain namespace hash, which is what the event stream needs — the
 * console can adopt a workspace we never presented (a sibling create), so the
 * namespace we logged was the transport's and never the one the item went into.
 *
 * That mismatch is why adoption was invisible: `session` and `tns` were identical
 * on every event, which is precisely the drift `session` was supposed to show.
 * The hash is not a credential — only a signed token is accepted as one.
 */
export function captureWorkspaceNamespace(
  auth: AuthContext,
  job: { workspaceNamespace?: string | null } | null,
): void {
  if (!job?.workspaceNamespace || auth.type !== "freePlan") return;
  auth.effectiveNamespace = job.workspaceNamespace;
}

export async function createItem(options: {
  auth: AuthContext;
  lang: string;
  name?: string;
  taskId?: string;
  help?: string;
  client?: string;
}): Promise<Item> {
  const { auth, lang, name, taskId, help, client } = options;

  const mutation = `
    mutation CreateItem($lang: String!, $name: String, $taskId: String, $help: String, $client: String) {
      createItem(lang: $lang, name: $name, taskId: $taskId, help: $help, client: $client) {
        id
        name
        taskId
        lang
        help
        isPublic
        created
        updated
        client
        workspace
        claimToken
      }
    }
  `;

  const result = await graphqlRequest<{ createItem: Item }>(
    auth,
    mutation,
    { lang, name, taskId, help, client }
  );

  captureWorkspace(auth, result.createItem);
  return result.createItem;
}

export async function getItem(options: {
  auth: AuthContext;
  id: string;
}): Promise<Item | null> {
  const { auth, id } = options;

  const query = `
    query GetItem($id: String!) {
      item(id: $id) {
        id
        name
        taskId
        lang
        help
        isPublic
        created
        updated
        client
        claimToken
      }
    }
  `;

  const result = await graphqlRequest<{ item: Item | null }>(
    auth,
    query,
    { id }
  );

  return result.item;
}

export interface ItemWithTask extends Item {
  task: {
    id: string;
    lang: string;
    code: string;
    src: string;
  } | null;
}

export async function getItemWithTask(options: {
  auth: AuthContext;
  id: string;
}): Promise<ItemWithTask | null> {
  const { auth, id } = options;

  const query = `
    query GetItemWithTask($id: String!) {
      item(id: $id) {
        id
        name
        taskId
        lang
        help
        isPublic
        created
        updated
        client
        claimToken
        generationStatus
        generationError
        generationStartedAt
        generationChars
        task {
          id
          lang
          code
          src
        }
      }
    }
  `;

  const result = await graphqlRequest<{ item: ItemWithTask | null }>(
    auth,
    query,
    { id }
  );

  return result.item;
}

export interface ItemSpec {
  spec: string;
  lang: string;
  itemId: string;
  coverage: { checked: number; missing: string[] };
}

export async function getSpec(options: {
  auth: AuthContext;
  id: string;
}): Promise<ItemSpec> {
  const { auth, id } = options;

  const query = `
    query GetSpec($id: String!) {
      spec(id: $id) {
        spec
        lang
        itemId
        coverage { checked missing }
      }
    }
  `;

  const result = await graphqlRequest<{ spec: ItemSpec }>(auth, query, { id });
  return result.spec;
}

export async function updateItem(options: {
  auth: AuthContext;
  id: string;
  name?: string;
  taskId?: string;
  help?: string;
}): Promise<Item> {
  const { auth, id, name, taskId, help } = options;

  const mutation = `
    mutation UpdateItem($id: String!, $name: String, $taskId: String, $help: String) {
      updateItem(id: $id, name: $name, taskId: $taskId, help: $help) {
        id
        name
        taskId
        lang
        help
        isPublic
        created
        updated
        client
        workspace
        claimToken
      }
    }
  `;

  const result = await graphqlRequest<{ updateItem: Item }>(
    auth,
    mutation,
    { id, name, taskId, help }
  );

  captureWorkspace(auth, result.updateItem);
  return result.updateItem;
}

// --- Languages (queried from backend) ---

const LANGUAGE_CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const listLanguagesCache = new Map<string, CacheEntry<Language[]>>();

/**
 * Two deadlines, chosen by whether we have anything to fall back to.
 *
 * With a fallback, fail FAST: a stale catalog now beats a fresh one in 20s, and the
 * catalog changes on language deploys, not minute to minute.
 *
 * With nothing cached, wait LONG. A cold Cloud Run console revision takes ~18s to
 * boot (measured), so a short deadline on the first call of a process would turn a
 * normal cold start into a hard failure — the exact failure this code exists to
 * prevent, just relocated.
 */
let CATALOG_TIMEOUT_WITH_FALLBACK_MS = 2500;
let CATALOG_TIMEOUT_COLD_MS = 25000;

/** Tests shorten the deadlines and clear the catalog state between cases. */
export function __setCatalogDeadlinesForTest(d: { fallbackMs: number; coldMs: number }): void {
  CATALOG_TIMEOUT_WITH_FALLBACK_MS = d.fallbackMs;
  CATALOG_TIMEOUT_COLD_MS = d.coldMs;
}
export function __resetCatalogForTest(): void {
  listLanguagesCache.clear();
  listLanguagesInflight.clear();
  lastGoodFullCatalog = null;
}

/**
 * The last catalog the console successfully returned for the UNFILTERED query, and
 * the in-flight refreshes keyed by cache key.
 *
 * `lastGoodFullCatalog` is the cross-key safety net. The per-key cache is keyed by
 * `domain|search`, and agents send arbitrary phrasings, so on any novel search the
 * per-key fallback is empty precisely when it is needed. A superset of the catalog
 * is a far better answer than an error: the agent can still see what exists.
 *
 * NOTE it is deliberately NOT filtered locally to match the requested search. The
 * console owns search — vendor gating, stopwords, ranking, the result cap — and
 * reimplementing that here would fork routing policy across two repos and drift.
 * Serving the superset is honest; serving a locally-scored guess would not be.
 */
let lastGoodFullCatalog: Language[] | null = null;

/**
 * The last known full catalog, synchronously and without a fetch.
 *
 * Exists so SERVER_INSTRUCTIONS can carry the catalog inline. Instructions are
 * built while the MCP session is being created, which is the one place that must
 * never wait on the console — so this returns what we already have or null, and
 * the caller falls back to instructions that tell the model to call
 * list_languages() instead. Warmed at startup by warmCatalog().
 */
export function getCachedFullCatalog(): Language[] | null {
  return lastGoodFullCatalog;
}

/**
 * Best-effort catalog prefetch, so the first session's instructions can carry it.
 * Never throws and never blocks startup.
 */
export async function warmCatalog(auth: AuthContext): Promise<void> {
  // Logged at both ends: a warm-up that starts and never settles is how discovery went
  // dark for eleven hours on 2026-09-30 (see listLanguages), and without these two lines
  // nothing in the logs said so.
  const startedAt = Date.now();
  console.log("[catalog] warm started");
  try {
    const languages = await listLanguages({ auth });
    console.log(`[catalog] warm ok: ${languages.length} languages in ${Date.now() - startedAt}ms`);
  } catch (err) {
    console.error(`[catalog] warm failed after ${Date.now() - startedAt}ms: ${(err as Error)?.message ?? err}`);
  }
}

/** The one error list_languages surfaces: worded so a model tells the user rather than retrying. */
class CatalogUnavailable extends Error {}
function catalogUnavailable(err: unknown): CatalogUnavailable | FreePlanLimitError {
  // A free-plan refusal is not an outage: pass it through so it reads as ours.
  if (err instanceof FreePlanLimitError) return err;
  const why = (err as Error)?.message ?? String(err);
  return new CatalogUnavailable(
    "The Graffiticode language catalog is temporarily unavailable " +
      `(${why}). This is a transient upstream problem, not a ` +
      "problem with your request. Do NOT retry list_languages — tell the user " +
      "Graffiticode can't be reached right now and ask them to try again shortly."
  );
}

/** A refresh in flight, and when it started, so a caller can tell a live one from a wedged one. */
interface Inflight {
  promise: Promise<Language[]>;
  startedAt: number;
}
const listLanguagesInflight = new Map<string, Inflight>();

/** Settle with `p`, or reject after `ms` — whichever is first. The timer never outlives it. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Request timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}
const getLanguageInfoCache = new Map<string, CacheEntry<LanguageInfo | null>>();

export interface Language {
  id: string;
  name: string;
  description: string;
  // The catalog's steering text — including negative gates ("do NOT use for…").
  // Surfaced to agents as `when_to_use` at discovery time; without it the
  // catalog can only pull a language in, never push a wrong pick away.
  routingHint?: string | null;
  domains: string[];
}

/**
 * The catalog, with a defense in front of it.
 *
 * A user watched Claude loop on list_languages: the console was briefly unreachable,
 * `graphqlRequest` threw a bare `fetch failed`, and an opaque tool error is something
 * a model answers by calling the tool again. Nothing downstream of that error could
 * fix it — the fix is to not surface it. In order:
 *
 *   1. fresh cache        -> return it
 *   2. stale cache        -> return it AND refresh in the background (never blocks)
 *   3. nothing cached     -> await the fetch, on the long deadline
 *   4. fetch failed       -> stale entry for this key, else the last good full catalog
 *   5. nothing at all     -> throw, with text that tells the model NOT to retry
 *
 * Mirrors getSkillCatalog() in resources.ts, which already does exactly this for the
 * skills catalog; the shape is deliberately the same so there is one pattern here.
 */
export async function listLanguages(options: {
  auth: AuthContext;
  domain?: string;
  search?: string;
}): Promise<Language[]> {
  const { auth, domain, search } = options;

  const cacheKey = `${domain ?? ""}|${search ?? ""}`;
  const cached = listLanguagesCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const haveFallback = !!cached || !!lastGoodFullCatalog;
  const deadlineMs = haveFallback ? CATALOG_TIMEOUT_WITH_FALLBACK_MS : CATALOG_TIMEOUT_COLD_MS;

  // Join a refresh already in flight only while it is younger than the longest deadline
  // it could have been given. An older one has outlived its own abort and is wedged: on
  // 2026-09-30 the startup warm-up's fetch never settled, and because every call joined
  // it, list_languages hung for every client, on every revision, for eleven hours, while
  // get_language_info — which has no in-flight map — kept working.
  let entry = listLanguagesInflight.get(cacheKey);
  if (entry && Date.now() - entry.startedAt > CATALOG_TIMEOUT_COLD_MS) {
    console.error(`[catalog] replacing a refresh wedged for ${Date.now() - entry.startedAt}ms`);
    entry = undefined;
  }
  if (!entry) {
    const fresh: Inflight = { startedAt: Date.now(), promise: null as unknown as Promise<Language[]> };
    fresh.promise = fetchLanguages(auth, domain, search, haveFallback)
      .then((languages) => {
        listLanguagesCache.set(cacheKey, {
          value: languages,
          expiresAt: Date.now() + LANGUAGE_CACHE_TTL_MS,
        });
        // Only the unfiltered query may seed the cross-key net; a search result is a
        // subset and would masquerade as the whole catalog on some later miss.
        if (!domain && !search) lastGoodFullCatalog = languages;
        return languages;
      })
      .catch((err) => {
        console.error(`[catalog] refresh failed: ${err?.message ?? err}`);
        if (cached) return cached.value;
        if (lastGoodFullCatalog) return lastGoodFullCatalog;
        throw catalogUnavailable(err);
      })
      .finally(() => {
        // Only our own entry: a wedged refresh that settles late must not evict the
        // healthy one that replaced it.
        if (listLanguagesInflight.get(cacheKey) === fresh) listLanguagesInflight.delete(cacheKey);
      });
    listLanguagesInflight.set(cacheKey, fresh);
    entry = fresh;
  }

  // Stale-while-revalidate: a stale entry answers now, the refresh above lands later.
  if (cached) return cached.value;
  // This caller's own deadline, independent of the fetch's abort. If the fetch ignores
  // its signal, the caller still gets an answer — the last good catalog, or the
  // do-not-retry error — instead of waiting with it.
  return withDeadline(entry.promise, deadlineMs + 1000).catch((err) => {
    if (lastGoodFullCatalog) return lastGoodFullCatalog;
    throw err instanceof CatalogUnavailable ? err : catalogUnavailable(err);
  });
}

async function fetchLanguages(
  auth: AuthContext,
  domain: string | undefined,
  search: string | undefined,
  haveFallback: boolean
): Promise<Language[]> {
  const query = `
    query ListLanguages($domain: String, $search: String) {
      languages(domain: $domain, search: $search) {
        id
        name
        description
        routingHint
        domains
      }
    }
  `;

  const result = await graphqlRequest<{ languages: Language[] }>(
    auth,
    query,
    { domain, search },
    { timeoutMs: haveFallback ? CATALOG_TIMEOUT_WITH_FALLBACK_MS : CATALOG_TIMEOUT_COLD_MS }
  );

  return result.languages;
}

export interface ExamplePrompt {
  prompt: string;
  produces?: string | null;
  notes?: string | null;
}

export interface LanguageScope {
  summary: string;
  inScope: string[];
  outOfScope: string[];
}

export interface LanguageInfo {
  id: string;
  name: string;
  description: string;
  routingHint?: string | null;
  domains: string[];
  specUrl: string;
  authoringGuide: string | null;
  supportedItemTypes: string[];
  examplePrompts: ExamplePrompt[];
  usageGuide: string | null;
  scope?: LanguageScope | null;
}

export async function getLanguageInfo(options: {
  auth: AuthContext;
  language: string;
}): Promise<LanguageInfo | null> {
  const { auth, language } = options;

  // Normalize language ID (remove "L" prefix if present)
  const langId = language.replace(/^L/i, "");

  const cached = getLanguageInfoCache.get(langId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const query = `
    query GetLanguageInfo($id: String!) {
      language(id: $id) {
        id
        name
        description
        routingHint
        domains
        specUrl
        authoringGuide
        supportedItemTypes
        examplePrompts {
          prompt
          produces
          notes
        }
        usageGuide
        scope {
          summary
          inScope
          outOfScope
        }
      }
    }
  `;

  const result = await graphqlRequest<{ language: LanguageInfo | null }>(
    auth,
    query,
    { id: langId }
  );

  getLanguageInfoCache.set(langId, {
    value: result.language,
    expiresAt: Date.now() + LANGUAGE_CACHE_TTL_MS,
  });

  return result.language;
}

export async function getTemplate(language: string): Promise<string | null> {
  const langId = language.replace(/^L/i, "");
  const startedAt = Date.now();
  try {
    const response = await fetch(`${API_URL}/L${langId}/template.gc`);
    recordUpstream(startedAt);
    if (!response.ok) return null;
    const text = await response.text();
    return text || null;
  } catch {
    return null;
  }
}
