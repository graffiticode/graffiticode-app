// Hourly funnel digest: read the period's MCP events out of Cloud Logging, roll
// them up, and render one SMS.
//
// SCOPE: MCP activity only, excluding our own accounts. The report answers "what
// did agents do over MCP", so console-surface authoring is filtered out at the
// reader (isMcpOrigin) and our dev/eval accounts with it (isExcludedAccount).
// It counted our own console work before, which is a demand signal that reads as
// real and isn't; a report you have to mentally subtract yourself from is worse
// than one that says zero.
//
// A scheduled PULL rather than a push pipeline. Every service already writes its
// events to Cloud Logging as JSON lines (console via src/lib/funnel-events.ts,
// mcp-service via its own src/events.ts, app.graffiticode.org for artifact
// views), so reading them back on a timer needs no log sink, no Pub/Sub topic,
// and no per-event alerting state. Cloud Scheduler runs it at :02 past each hour
// from 8am to 8pm PT — see src/pages/api/internal/funnel-digest.ts.
//
// We call the Logging REST API directly (fetch + metadata-server token) rather
// than @google-cloud/logging, for the reason documented on generation-queue.ts:
// the SDKs load runtime config that Next standalone output-tracing doesn't
// bundle, which 500s the route.

import { getFirestore } from "../utils/db";
import { getAccessToken } from "./gcp-token";
// "0166" and "L0166" are the same language; item docs use one, MCP args the
// other. Shared with the workspace registry so both bucket a language alike.
import { langKey } from "./funnel-events";
import { isExcludedSession } from "./funnel-exclusions";
import { classifyConnect, isProbeKind } from "./funnel-clients";

const PROJECT =
  process.env.GENERATION_QUEUE_PROJECT ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCLOUD_PROJECT ||
  "graffiticode-app";

const TZ = "America/Los_Angeles";

/**
 * When true, a report covers everything since the last one actually sent, so the
 * 8am report carries the whole overnight rather than just 7-8am and nothing can
 * fall through the gap between schedules. Set false for strict 1-hour windows.
 */
const COVER_SINCE_LAST_REPORT = true;

/** Ingestion lag guard: never read closer to now than this. */
const INGEST_LAG_MS = 60_000;

/** Bound a runaway read. Exceeding this is reported, never silently dropped. */
const MAX_PAGES = 20;
const PAGE_SIZE = 1000;

const STATE_DOC = "alert-state/digest";
const SEEN_DOC = "alert-state/seen";

export interface LogEvent {
  ev: string;
  t?: string;
  session?: string;
  auth?: string;
  [key: string]: unknown;
}

// --- MCP origin -------------------------------------------------------------

/**
 * Events emitted by the MCP server itself. Every one of them describes an agent
 * talking to us over MCP, so no further qualification is needed.
 */
const MCP_SERVER_EVENTS = new Set([
  "mcp_connect",
  "mcp_listed",
  "mcp_resource",
  "mcp_session_started",
  "mcp_tool",
]);

/**
 * Console-emitted events that belong to the MCP funnel despite the console
 * being the process that logs them. The trial claim flow exists only to convert
 * an anonymous MCP workspace into an account — there is no console-surface way
 * to reach it — so a claim is MCP activity no matter who writes the log line.
 */
const MCP_FUNNEL_EVENTS = new Set([
  "claim",
  "claim_view",
  "claim_auth_shown",
  "claim_email_submitted",
]);

/**
 * Console-emitted events that describe authoring and therefore have to be
 * qualified by the surface that requested it. Each stamps `app` from the
 * mutation's `client` argument (resolvers.ts for the first two, generate-job.ts
 * for the third, which carries it through the queued job), so "mcp" here is
 * positive evidence rather than an absence.
 */
const SURFACE_QUALIFIED_EVENTS = new Set([
  "item_created",
  "item_updated",
  "item_generation_failed",
  "non_english_request",
]);

/**
 * Whether an event describes MCP activity.
 *
 * The report is about what agents do over MCP, so this is an ALLOWLIST: an
 * unrecognized event is not MCP. The alternative — dropping a known console set
 * and letting everything else through — silently re-admits console traffic the
 * next time an emitter is added, which is exactly the failure this filter
 * exists to fix (the report was counting our own console authoring as demand).
 *
 * Deliberately excluded, and each one goes quiet as a result: signup,
 * plan_changed, payg_enabled, checkout_started, api_key_created,
 * overage_limit_raised, wall_hit, free_plan_budget (none carries an `app` field
 * to qualify it by) and artifact_view (app.graffiticode.org, not MCP).
 *
 * What that costs in the SMS (formatSms): the ⛔ wall line and the $ revenue
 * line can no longer fire at all, and the ★ line narrows to claims only (signups
 * and api keys drop out of it). Both are `> 0`-guarded, so they omit their line
 * rather than printing a misleading zero.
 *
 * The exclusion is not permanent — stamp `app` at the emitter and add the event
 * to SURFACE_QUALIFIED_EVENTS. item_generation_failed did exactly that on
 * 2026-08-05 (the `client` now rides the queued job; see generation-queue.ts).
 */
export function isMcpOrigin(e: LogEvent): boolean {
  if (MCP_SERVER_EVENTS.has(e.ev)) return true;
  if (MCP_FUNNEL_EVENTS.has(e.ev)) return true;
  if (SURFACE_QUALIFIED_EVENTS.has(e.ev)) return e.app === "mcp";
  return false;
}

// --- Excluded accounts ------------------------------------------------------

/**
 * Whether this event belongs to an account the report deliberately ignores.
 * The list itself lives in src/lib/funnel-exclusions.ts, shared with the
 * write-time `internal` stamp on the workspace registry.
 *
 * Only ever matches authenticated traffic. Free-plan events carry a
 * sessionNamespace in this same field — also a sha256 hex digest, so the two
 * are structurally identical and only the `auth` value tells them apart, but a
 * collision between a namespace and one of our uid hashes is not a practical
 * concern. Anonymous internal traffic is therefore invisible here by
 * construction; that is what the registry's `internal` flag is for.
 */
export function isExcludedAccount(e: LogEvent): boolean {
  return isExcludedSession(typeof e.session === "string" ? e.session : undefined);
}

// --- Anonymous vs signed-in -------------------------------------------------

/**
 * Which side of the sign-in line an event falls on.
 *
 * `auth: "firebase"` is the only positive evidence that a signed-in account did
 * something — every emitter stamps it from `actor()`/`identify()`. artifact_view
 * comes from app.graffiticode.org, which has no auth vocabulary and reports a
 * plain `authed` boolean instead; it is honoured here so a signed-in form view
 * isn't filed as anonymous.
 *
 * Everything else is anonymous: free-plan trial traffic, and the account-less
 * events (claim_view, claim_auth_shown, claim_email_submitted, claim) that carry
 * no auth field at all because there is no
 * account yet — they ARE the anonymous funnel. Defaulting the unmarked case to
 * anonymous rather than a third bucket keeps `anon + authed == total` exactly,
 * so the two report sections can't quietly lose events between them.
 */
export function isAuthenticated(e: LogEvent): boolean {
  return e.auth === "firebase" || e.authed === true;
}

export interface SplitDigest {
  /** Everything in the window. */
  all: Digest;
  /** Free-plan / no-sign-in traffic — what the SMS reports. */
  anon: Digest;
  /** Signed-in accounts, including our own console use. */
  authed: Digest;
}

/**
 * Aggregate a window three ways: total, anonymous, signed-in.
 *
 * Segmenting the EVENTS and re-running the same aggregate — rather than
 * threading a segment through every counter — means the two sections can never
 * drift from the total or from each other, and session dedupe stays correct
 * within each side (one workspace that is anonymous cannot also be signed in).
 *
 * Only the total consumes `seen`: novelty is one-way state owned by the SMS, and
 * announcing a client kind twice (once per segment) would spend the flag on the
 * side that happened to aggregate first. The segment digests get throwaway sets
 * and their flags are cleared.
 */
export function aggregateSplit(
  events: LogEvent[],
  window: { from: Date; to: Date; truncated: boolean },
  seen: { clientKinds: Set<string>; geos: Set<string> },
): SplitDigest {
  const fresh = () => ({ clientKinds: new Set<string>(), geos: new Set<string>() });
  const all = aggregate(events, window, seen);
  const segment = (keep: (e: LogEvent) => boolean) => {
    const d = aggregate(events.filter(keep), window, fresh());
    d.workspaces.newClientKinds = [];
    d.workspaces.newGeos = [];
    return d;
  };
  return {
    all,
    anon: segment((e) => !isAuthenticated(e)),
    authed: segment(isAuthenticated),
  };
}

// --- Cloud Logging ----------------------------------------------------------

/**
 * Fetch every MCP-origin `ev`-bearing log entry in [from, to). Returns the
 * events plus whether the page cap truncated the read.
 *
 * Both filters — MCP origin and excluded accounts — are applied HERE, at the one
 * reader all three surfaces share (SMS, /r/<token>, scripts/funnel-report.ts),
 * for the same reason the aggregation itself is shared: a surface that filtered
 * on its own could drift. They are applied in code rather than folded into the
 * Logging query so each definition lives in exactly one place — see isMcpOrigin
 * and isExcludedAccount.
 *
 * Note this means paging still walks console events; MAX_PAGES bounds entries
 * READ, not entries kept, so a noisy console hour can still truncate the window.
 */
export async function fetchEvents(
  from: Date,
  to: Date,
): Promise<{ events: LogEvent[]; truncated: boolean }> {
  const token = await getAccessToken();
  const filter = [
    `timestamp >= "${from.toISOString()}"`,
    `timestamp < "${to.toISOString()}"`,
    `jsonPayload.ev:*`,
  ].join(" AND ");

  const events: LogEvent[] = [];
  let pageToken: string | undefined;
  let pages = 0;

  do {
    const res = await fetch("https://logging.googleapis.com/v2/entries:list", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        resourceNames: [`projects/${PROJECT}`],
        filter,
        orderBy: "timestamp asc",
        pageSize: PAGE_SIZE,
        ...(pageToken ? { pageToken } : {}),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`logging entries:list failed: ${res.status} ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      entries?: Array<{ jsonPayload?: LogEvent }>;
      nextPageToken?: string;
    };
    for (const entry of json.entries ?? []) {
      const payload = entry.jsonPayload;
      if (!payload?.ev) continue;
      if (!isMcpOrigin(payload)) continue;
      if (isExcludedAccount(payload)) continue;
      events.push(payload);
    }
    pageToken = json.nextPageToken;
    pages++;
  } while (pageToken && pages < MAX_PAGES);

  return { events, truncated: !!pageToken };
}

// --- Aggregation ------------------------------------------------------------

export interface Digest {
  from: Date;
  to: Date;
  truncated: boolean;
  /**
   * Distinct WORKSPACES active in the window — not transport sessions.
   *
   * The event's `session` field carries `sessionNamespace`, which CLAUDE.md
   * defines as the workspace: an MCP session is an ephemeral transport binding
   * that some hosts re-mint per tool call, while the workspace survives that via
   * adoptWorkspace. The wire field keeps the name `session` because
   * scripts/mcp-funnel-report.ts joins on it and 30d of logs already use it.
   */
  workspaces: {
    total: number;
    byClient: Record<string, number>;
    newClientKinds: string[];
    newGeos: string[];
  };
  /**
   * `failed` is generations that broke; `outOfScope` is requests correctly
   * refused because no language serves them. Kept apart so a right "no" doesn't
   * read as a generator fault — see isOutOfScopeRefusal.
   */
  items: {
    ok: number;
    failed: number;
    outOfScope: number;
    byApp: Record<string, number>;
    firstForAccount: number;
  };
  /**
   * Language use. `created` counts items that actually compiled; `attempted`
   * counts tool calls naming that language. The gap between them is the
   * language's failure rate — which is why they're kept apart rather than
   * summed. Keys are normalized to "L0166" form; events carry both spellings
   * (item docs store "0166", MCP tool args pass "L0166").
   */
  languages: { created: Record<string, number>; attempted: Record<string, number> };
  /**
   * Requests whose PROMPT was not written in English — demand we currently
   * refuse. Distinct from `languages` above in every way: that one counts the
   * GRAFFITICODE DIALECT ("L0166"), this one the NATURAL language the request
   * was typed in ("cyrillic", "fr").
   *
   * `blocked` counts those actually refused; total - blocked were observed with
   * NON_ENGLISH_GATE=shadow, where the gate measures but does not refuse. Keys
   * are `plang ?? script`, so granularity is mixed on purpose — see
   * src/lib/prompt-language.ts.
   */
  nonEnglish: { total: number; blocked: number; byLang: Record<string, number> };
  walls: Record<string, number>;
  claims: { count: number; transferred: number };
  signups: { direct: number; viaClaim: number };
  plans: Array<{ from?: string; to?: string; reason?: string }>;
  /**
   * Pay-as-you-go enrollments: a hard-capped tier putting its first card on
   * file. Counted apart from `plans` because the plan id doesn't move, so it is
   * invisible to plan_changed — but it is the free tier's conversion moment.
   */
  paygEnabled: number;
  overageRaised: number;
  apiKeys: number;
  context: {
    edits: number;
    views: number;
    toolCalls: number;
    connectsWithoutUse: number;
    claimViews: number;
    claimAuthShown: number;
    claimEmailSubmitted: number;
    checkoutAbandoned: number;
    genFailures: number;
    budgetThreshold?: number;
  };
  /**
   * What connected, and how far it got — the inside of `connectsWithoutUse`.
   *
   * That one number counted every connect that never called a tool and the
   * report filed the lot as "probes filtered", which is how ~1,100 sessions of
   * real agent hosts came to be reported as noise. They are not the same thing
   * as a Censys scan: a host that opened a transport, took our catalog, and
   * passed on it is a positioning result, and it's the number that instruction
   * work is supposed to move.
   *
   * `listed`/`read` come from the MCP server's mcp_listed/mcp_resource events.
   * Windows that predate them must render blank, not zero — see `instrumented`.
   */
  reach: {
    byClient: Record<
      string,
      { connects: number; sessions: number; listed: number; read: number; used: number }
    >;
    /** Self-identifying automation, collapsed to one line. */
    crawlers: { sessions: number; byName: Record<string, number> };
    /** Connects with no client_kind at all — pre-2026-07-28 data, and clients that send none. */
    unnamed: number;
    /** Agent sessions that connected and never called a tool. THE number. */
    agentIdle: number;
    /** Whether mcp_listed exists in this window at all. */
    instrumented: boolean;
  };
}

// The client-classification vocabulary lives in ./funnel-clients (a leaf module
// with no imports, so scripts can read it without pulling Firestore in).
// Re-exported here because this is where callers already look for it.
export { classifyClient, classifyConnect, isProbeKind, type ClientClass } from "./funnel-clients";

function langSafeKind(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function geoOf(e: LogEvent): string | undefined {
  return typeof e.geo_country === "string" ? e.geo_country : undefined;
}

function bump(map: Record<string, number>, key: string | undefined, by = 1): void {
  if (!key) return;
  map[key] = (map[key] ?? 0) + by;
}

/**
 * MCP tools that actually try to BUILD something in a language.
 *
 * Deliberately an allowlist, not "has a lang field". get_language_info takes
 * `language` as its argument, so a docs lookup carries one; counting it as an
 * attempt inflates a language's failure rate and can mark it as tried-and-failed
 * when nobody tried. Any new authoring tool must be added here.
 */
const AUTHORING_TOOLS = new Set(["create_item", "update_item"]);

/** The scope gate's refusal text (generate-for-request.ts), for events that predate `code`. */
const SCOPE_GATE_REFUSAL_PREFIX = "This request doesn't fit any available Graffiticode language.";

/**
 * Whether an item_generation_failed was a correct out-of-scope refusal rather
 * than a broken generation.
 *
 * `code` is authoritative (generate-job.ts stamps it). Older events carry only
 * `err`, so they fall back to the scope gate's prefix — never to the model
 * sentinel's "Out of scope:", which on 2026-09-09 was also what the composition
 * planner leaked from an upstream the user never named: a bug, not a refusal.
 */
function isOutOfScopeRefusal(e: LogEvent): boolean {
  if (e.code === "out_of_scope") return true;
  return typeof e.err === "string" && e.err.startsWith(SCOPE_GATE_REFUSAL_PREFIX);
}

/**
 * Roll events into the digest shape.
 *
 * `seen` carries the client kinds and countries observed in every prior period,
 * so novelty is a diff computed here rather than something each emitter has to
 * track. It is mutated with anything new, and the caller persists it.
 */
export function aggregate(
  events: LogEvent[],
  window: { from: Date; to: Date; truncated: boolean },
  seen: { clientKinds: Set<string>; geos: Set<string> },
): Digest {
  const d: Digest = {
    from: window.from,
    to: window.to,
    truncated: window.truncated,
    workspaces: { total: 0, byClient: {}, newClientKinds: [], newGeos: [] },
    items: { ok: 0, failed: 0, outOfScope: 0, byApp: {}, firstForAccount: 0 },
    languages: { created: {}, attempted: {} },
    nonEnglish: { total: 0, blocked: 0, byLang: {} },
    walls: {},
    claims: { count: 0, transferred: 0 },
    signups: { direct: 0, viaClaim: 0 },
    plans: [],
    paygEnabled: 0,
    overageRaised: 0,
    apiKeys: 0,
    context: {
      edits: 0,
      views: 0,
      toolCalls: 0,
      connectsWithoutUse: 0,
      claimViews: 0,
      claimAuthShown: 0,
      claimEmailSubmitted: 0,
      checkoutAbandoned: 0,
      genFailures: 0,
    },
    reach: {
      byClient: {},
      crawlers: { sessions: 0, byName: {} },
      unnamed: 0,
      agentIdle: 0,
      instrumented: false,
    },
  };

  // Session-level joins: what became of each connect, and a checkout that never
  // produced a plan change was abandoned.
  //
  // Keyed on `tns` — the MCP server's stable per-transport namespace — falling
  // back to `session` for events that predate that field. `session` alone
  // cannot carry this join: it starts as the transport's namespace and becomes
  // the console's WORKSPACE handle once a call adopts a workspace, so a connect
  // and the tool calls that followed it land under different values, and the
  // connect is then indistinguishable from one that went nowhere.
  //
  // Records are created by mcp_connect ONLY. This map is the inside of
  // connectsWithoutUse, so it holds exactly the connects made in this window;
  // a tool call from a session that connected in an earlier one is already
  // counted as a workspace and has no connect here to explain.
  interface Reach {
    kind?: string;
    connects: number;
  }
  const reach = new Map<string, Reach>();
  // What each key did is collected in sets and applied at the end, NOT flagged
  // onto the record as the loop goes. Flagging would only work if events
  // arrived in timestamp order: a tool call read before its own connect finds
  // no record yet and its session reports as idle. The live path does fetch
  // ascending, but `gcloud logging read` defaults to descending and any offline
  // analysis would then undercount by exactly the sessions that converted.
  const usedKeys = new Set<string>();
  const listedKeys = new Set<string>();
  const readKeys = new Set<string>();
  const reachKey = (e: LogEvent): string | undefined => {
    if (typeof e.tns === "string" && e.tns) return e.tns;
    return typeof e.session === "string" && e.session ? e.session : undefined;
  };
  const mark = (set: Set<string>, e: LogEvent): void => {
    const key = reachKey(e);
    if (key) set.add(key);
  };
  const checkoutStarted = new Set<string>();
  const planChanged = new Set<string>();
  // workspace namespace -> the client kind / geo it presented, deduped.
  //
  // Populated from EVERY event that names a client, not just mcp_session_started.
  // A session's start event fires only on its first tool call, so a conversation
  // that began in an earlier window keeps working here while emitting no start
  // event — attributing off starts alone left those clients unnamed even though
  // they were plainly active.
  const active = new Map<string, { kind: string; geo?: string }>();

  // Which sessions belong to crawlers, probes, and our own tooling.
  //
  // A PRE-PASS, for the same reason usedKeys/listedKeys are sets applied at the
  // end: a single pass can only classify an event whose own payload names the
  // client, and item_created carries `app` but no client_kind. Its session is
  // named by the mcp_tool call that produced it, which may be read after it.
  // Flagging as we go would let a scanner's items through whenever the log
  // arrived in a different order — and `gcloud logging read` defaults to
  // descending, so offline analysis would disagree with the live path.
  const probeKeys = new Set<string>();
  for (const e of events) {
    if (!isProbeKind(langSafeKind(e.client_kind))) continue;
    const k = reachKey(e);
    if (k) probeKeys.add(k);
    if (typeof e.session === "string" && e.session) probeKeys.add(e.session);
  }
  /**
   * Probe traffic is excluded from the DEMAND counters (workspaces, tool calls,
   * items, languages) and kept in `reach`, which exists to report exactly this.
   * Dropping it at fetchEvents instead would have emptied the crawler rows —
   * the evidence and the noise are the same events, told apart only here.
   */
  const isProbe = (e: LogEvent): boolean => {
    const kind = langSafeKind(e.client_kind);
    if (kind) return isProbeKind(kind);
    const k = reachKey(e);
    if (k && probeKeys.has(k)) return true;
    return typeof e.session === "string" && probeKeys.has(e.session);
  };

  for (const e of events) {
    const session = typeof e.session === "string" ? e.session : undefined;
    switch (e.ev) {
      case "mcp_connect": {
        const key = reachKey(e);
        if (key) {
          const r = reach.get(key) ?? { connects: 0 };
          r.connects++;
          // First non-empty name wins. One key can span several connects, and
          // the older ones predate client_kind — a key that ever named itself
          // is named.
          if (!r.kind) r.kind = langSafeKind(e.client_kind);
          reach.set(key, r);
        }
        break;
      }

      // The two stages between "a transport opened" and "someone asked for
      // something". Absent these, a directory validator and an agent host that
      // read our guides and passed produce identical evidence.
      case "mcp_listed":
        d.reach.instrumented = true;
        mark(listedKeys, e);
        break;

      case "mcp_resource":
        mark(readKeys, e);
        break;

      case "mcp_tool":
        // usedKeys is marked for probes too: reach reports what a crawler did,
        // and a scanner that called a tool is not a connect "without use".
        mark(usedKeys, e);
        if (isProbe(e)) break;
        d.context.toolCalls++;
        if (session) {
          const kind = langSafeKind(e.client_kind);
          if (kind && !active.has(session)) {
            active.set(session, { kind, geo: geoOf(e) });
          }
        }
        // Authoring calls only. Carrying a `lang` is NOT sufficient:
        // get_language_info takes `language` as its argument, so a docs lookup
        // emits one too and would be counted as a failed attempt to build —
        // rendering a language red for "tried, made nothing" when nobody tried.
        if (AUTHORING_TOOLS.has(String(e.tool))) {
          bump(d.languages.attempted, langKey(e.lang));
        }
        if (e.outcome === "generation_failed") d.context.genFailures++;
        break;

      case "mcp_session_started": {
        // Collected, not counted. The event fires once per server instance, and
        // one transport session can outlive or re-create that instance (Cloud
        // Run scaling, a host that re-binds mid-conversation). Deduping by
        // session id downstream makes the count right either way, where
        // incrementing here would report the same person twice.
        mark(usedKeys, e);
        if (isProbe(e)) break;
        active.set(session ?? `anon:${active.size}`, {
          kind: langSafeKind(e.client_kind) ?? "unknown",
          geo: geoOf(e),
        });
        break;
      }

      case "item_created":
        if (isProbe(e)) break;
        d.items.ok++;
        bump(d.items.byApp, typeof e.app === "string" ? e.app : "console");
        bump(d.languages.created, langKey(e.lang));
        if (e.first_for_account) d.items.firstForAccount++;
        break;

      case "item_updated":
        if (isProbe(e)) break;
        d.context.edits++;
        break;

      case "item_generation_failed":
        if (isProbe(e)) break;
        if (isOutOfScopeRefusal(e)) d.items.outOfScope++;
        else d.items.failed++;
        break;

      case "non_english_request": {
        if (isProbe(e)) break;
        d.nonEnglish.total++;
        if (e.blocked) d.nonEnglish.blocked++;
        // `plang ?? script`, mirroring promptLanguageKey(). Never `lang` — that
        // field is the dialect and is normalized through langKey().
        const key = typeof e.plang === "string" && e.plang
          ? e.plang
          : typeof e.script === "string" && e.script
            ? e.script
            : "unknown";
        bump(d.nonEnglish.byLang, key);
        break;
      }

      case "wall_hit":
        bump(d.walls, typeof e.wall === "string" ? e.wall : "unknown");
        break;

      case "claim":
        if (e.outcome === "ok") {
          d.claims.count++;
          d.claims.transferred += Number(e.transferred) || 0;
        }
        break;

      case "claim_view":
        d.context.claimViews++;
        break;

      case "claim_auth_shown":
        d.context.claimAuthShown++;
        break;

      case "claim_email_submitted":
        d.context.claimEmailSubmitted++;
        break;

      case "artifact_view":
        d.context.views++;
        break;

      case "signup":
        if (e.via === "claim") d.signups.viaClaim++;
        else d.signups.direct++;
        break;

      case "plan_changed":
        d.plans.push({
          from: typeof e.from === "string" ? e.from : undefined,
          to: typeof e.to === "string" ? e.to : undefined,
          reason: typeof e.reason === "string" ? e.reason : undefined,
        });
        if (session) planChanged.add(session);
        break;

      case "checkout_started":
        if (session) checkoutStarted.add(session);
        break;

      case "payg_enabled":
        d.paygEnabled++;
        if (session) planChanged.add(session);
        break;

      case "overage_limit_raised":
        d.overageRaised++;
        break;

      case "api_key_created":
        d.apiKeys++;
        break;

      case "free_plan_budget":
        d.context.budgetThreshold = Number(e.threshold) || undefined;
        break;
    }
  }

  // One session = one distinct id that used a tool in this window, however many
  // start events it produced. Novelty is diffed here, after the dedupe, so a
  // repeated start event can't announce the same client kind twice.
  d.workspaces.total = active.size;
  for (const { kind, geo } of active.values()) {
    bump(d.workspaces.byClient, kind);
    if (kind !== "unknown" && !seen.clientKinds.has(kind)) {
      seen.clientKinds.add(kind);
      d.workspaces.newClientKinds.push(kind);
    }
    if (geo && !seen.geos.has(geo)) {
      seen.geos.add(geo);
      d.workspaces.newGeos.push(geo);
    }
  }

  // One pass over the connects, splitting them by who made them. The total is
  // still reported as connectsWithoutUse — the SMS line is unchanged — but the
  // report page now gets to say which of them were machines announcing
  // themselves, which were nameless, and which were agent hosts that took the
  // catalog and left.
  for (const [key, r] of reach) {
    const used = usedKeys.has(key);
    if (!used) d.context.connectsWithoutUse++;
    switch (classifyConnect(r.kind)) {
      case "crawler":
        d.reach.crawlers.sessions++;
        bump(d.reach.crawlers.byName, r.kind);
        break;
      case "unnamed":
        d.reach.unnamed++;
        break;
      case "agent": {
        const row = (d.reach.byClient[r.kind as string] ??= {
          connects: 0,
          sessions: 0,
          listed: 0,
          read: 0,
          used: 0,
        });
        row.connects += r.connects;
        row.sessions++;
        if (listedKeys.has(key)) row.listed++;
        if (readKeys.has(key)) row.read++;
        if (used) row.used++;
        else d.reach.agentIdle++;
        break;
      }
    }
  }

  for (const s of checkoutStarted) if (!planChanged.has(s)) d.context.checkoutAbandoned++;

  return d;
}

/** Calendar date in PT, e.g. "2026-07-27". The unit "first of the day" counts in. */
export function ptDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

// Send policy: EVERY run sends, activity or not. The schedule IS the policy —
// Cloud Scheduler fires hourly 8am-8pm PT and each firing produces one message,
// so a quiet hour reports "0 tool calls" rather than going silent. Silence now
// means the job is broken, with no "was that a dead hour or a dead cron?"
// ambiguity to resolve. (There used to be an activity gate plus a once-a-day
// floor here; the floor existed only to make silence readable, which sending
// unconditionally does directly.)

// --- Formatting -------------------------------------------------------------

function ptTime(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function ptDayLabel(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    month: "short",
    day: "numeric",
  }).format(date);
}

/**
 * Human range for a window.
 *
 * Dates appear only when the window crosses a PT day. Without that, an
 * hour-of-the-day label like "18:08-18:08" is what a 24h window renders as —
 * technically true and completely useless. Hourly digests stay short; the
 * overnight window and any multi-day report get dated ends.
 */
export function ptRange(from: Date, to: Date): string {
  if (ptDate(from) === ptDate(to)) return `${ptTime(from)}\u2013${ptTime(to)} PT`;
  return `${ptDayLabel(from)} ${ptTime(from)} \u2013 ${ptDayLabel(to)} ${ptTime(to)} PT`;
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

/**
 * "claude-ai 2, cursor 1" — highest first, tail collapsed so the SMS stays short.
 *
 * Only for breakdowns where a long tail is noise (walls, surfaces). NEVER for
 * client kinds: which agents showed up is the point, and collapsing the 4th into
 * "+1 other" hides exactly the arrival worth knowing about. Use clientList().
 */
function breakdown(map: Record<string, number>, limit = 3): string {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  const head = entries.slice(0, limit).map(([k, v]) => `${k} ${v}`);
  const rest = entries.slice(limit).reduce((sum, [, v]) => sum + v, 0);
  if (rest > 0) head.push(`+${rest} other`);
  return head.join(", ");
}

/**
 * Every client kind that showed up, named, never truncated, with ⚑ on the ones
 * seen for the first time.
 *
 * Client names are raw MCP `clientInfo.name` values on purpose — no normalizing
 * families together. "claude-code" and "claude-ai" are different surfaces, and
 * "codex-mcp-client" vs "openai-mcp (Codex)" is a real version difference worth
 * seeing rather than smoothing away.
 */
function clientList(d: Digest): string {
  const isNew = new Set(d.workspaces.newClientKinds);
  return Object.entries(d.workspaces.byClient)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, v]) => `${isNew.has(k) ? "⚑" : ""}${k} ${v}`)
    .join(" · ");
}

/**
 * The SMS body. Three lines, or two on a quiet hour:
 *
 *   GC 19:01–20:01 PT 15 anon calls
 *   2 workspaces · 3 items
 *   https://console.graffiticode.org/r/<token>
 *
 * The call count lives on line 1 because a phone's unread list shows only that
 * line: a preview reading just the window said when, never what, so you had to
 * open the message to learn whether anyone showed up. Line 2 carries what's
 * left and is dropped entirely when there are no workspaces and no items.
 *
 * Pass the ANONYMOUS segment (see aggregateSplit). The text answers one
 * question — did a stranger use the product this hour — and mixing our own
 * signed-in console work into that number made a busy afternoon of my own
 * editing read as demand. The signed-in side isn't dropped, it's on the report
 * page, one tap away, alongside the total.
 *
 * Nothing else belongs here. Claims, plan changes, new-client arrivals, and
 * per-client breakdowns all live on that page, which has room for them and
 * doesn't pay per character. Every attempt to surface "just one more important
 * thing" in the text has ended up either redundant with the page or misleading
 * because the text can't carry the qualifiers.
 */
export function formatSms(d: Digest, url?: string): string {
  const calls = d.context.toolCalls;
  const rest: string[] = [];
  if (d.workspaces.total) rest.push(`${d.workspaces.total} workspace${plural(d.workspaces.total)}`);
  if (d.items.ok) rest.push(`${d.items.ok} item${plural(d.items.ok)}`);

  const lines = [`GC ${ptRange(d.from, d.to)} ${calls} anon call${plural(calls)}`];
  if (rest.length) lines.push(rest.join(" · "));
  if (url) lines.push(url);

  return lines.join("\n");
}

export function formatDigest(d: Digest): string {
  const lines: string[] = [`GC ${ptRange(d.from, d.to)}`];

  if (d.workspaces.total > 0) {
    let line = `▶ ${d.workspaces.total} workspace${plural(d.workspaces.total)}`;
    const parts = clientList(d);
    if (parts) line += ` — ${parts}`;
    if (d.workspaces.newGeos.length) line += ` ⚑geo ${d.workspaces.newGeos.join("/")}`;
    lines.push(line);
  }

  if (d.items.ok > 0 || d.items.failed > 0 || d.items.outOfScope > 0) {
    let line = `✎ ${d.items.ok} item${plural(d.items.ok)}`;
    if (d.items.failed > 0) line += `, ${d.items.failed} failed`;
    if (d.items.outOfScope > 0) line += `, ${d.items.outOfScope} out of scope`;
    const parts = breakdown(d.items.byApp);
    if (parts) line += ` — ${parts}`;
    if (d.items.firstForAccount > 0) line += ` ⚑${d.items.firstForAccount} first-ever`;
    lines.push(line);
  }

  // Demand we can't serve. Guarded like every other line so a quiet hour omits
  // it rather than printing a false zero. "(N blocked)" is the whole tell
  // between shadow mode (measuring) and enforce (refusing) — without it the
  // same number means two very different things.
  if (d.nonEnglish.total > 0) {
    let line = `🌐 ${d.nonEnglish.total} non-English — ${breakdown(d.nonEnglish.byLang)}`;
    if (d.nonEnglish.blocked > 0) line += ` (${d.nonEnglish.blocked} blocked)`;
    lines.push(line);
  }

  const wallTotal = Object.values(d.walls).reduce((a, b) => a + b, 0);
  if (wallTotal > 0) {
    lines.push(`⛔ ${wallTotal} wall${plural(wallTotal)} — ${breakdown(d.walls)}`);
  }

  const conversion: string[] = [];
  if (d.claims.count > 0) {
    conversion.push(
      `${d.claims.count} claim${plural(d.claims.count)}` +
        (d.claims.transferred ? ` (+${d.claims.transferred} items)` : ""),
    );
  }
  if (d.signups.direct > 0) conversion.push(`${d.signups.direct} signup direct`);
  if (d.apiKeys > 0) conversion.push(`${d.apiKeys} api key${plural(d.apiKeys)}`);
  if (conversion.length) lines.push(`★ ${conversion.join(" · ")}`);

  const revenue: string[] = [];
  for (const p of d.plans.slice(0, 4)) {
    const move = p.reason === "cancel_requested"
      ? `cancel req ${p.from ?? "?"}`
      : p.reason === "resume_requested"
        ? `resume ${p.from ?? "?"}`
        : `${p.from ?? "?"}→${p.to ?? "?"}`;
    revenue.push(move);
  }
  if (d.plans.length > 4) revenue.push(`+${d.plans.length - 4} more`);
  if (d.paygEnabled > 0) revenue.push(`${d.paygEnabled} card added`);
  if (d.overageRaised > 0) revenue.push(`${d.overageRaised} cap raised`);
  if (revenue.length) lines.push(`$ ${revenue.join(" · ")}`);

  const ctx: string[] = [];
  // Shown alongside the session count on purpose: it's the denominator. If
  // calls only ever equal sessions, hosts are re-binding per call and the ▶
  // number is transports, not people — visible here rather than buried.
  if (d.context.toolCalls) ctx.push(`${d.context.toolCalls} tool call${plural(d.context.toolCalls)}`);
  if (d.context.edits) ctx.push(`${d.context.edits} edit${plural(d.context.edits)}`);
  if (d.context.views) ctx.push(`${d.context.views} view${plural(d.context.views)}`);
  if (d.context.connectsWithoutUse) {
    ctx.push(`${d.context.connectsWithoutUse} connect${plural(d.context.connectsWithoutUse)} w/o use`);
  }
  // A claim-driven signup is the same happening the ★ line already reports, so
  // it's noted here rather than counted twice — but never dropped silently.
  if (d.signups.viaClaim) ctx.push(`${d.signups.viaClaim} signup via claim`);
  // Report WHERE an unconverted claim stopped, not just that it did. The three
  // stages narrow the drop to a step, which is the difference between "the page
  // isn't working" and "the ask is being declined" — two findings with nothing
  // in common as fixes. Stages that didn't happen are omitted rather than
  // printed as zero: the last one shown IS the drop-off point.
  if (d.context.claimViews && !d.claims.count) {
    const steps = [`${d.context.claimViews} claim view${plural(d.context.claimViews)}`];
    if (d.context.claimAuthShown) steps.push(`${d.context.claimAuthShown} saw sign-in`);
    if (d.context.claimEmailSubmitted) steps.push(`${d.context.claimEmailSubmitted} submitted email`);
    steps.push("0 claimed");
    ctx.push(steps.join(" → "));
  }
  if (d.context.checkoutAbandoned) ctx.push(`${d.context.checkoutAbandoned} checkout abandoned`);
  if (d.context.genFailures) ctx.push(`${d.context.genFailures} gen fail${plural(d.context.genFailures)}`);
  if (d.context.budgetThreshold) ctx.push(`trial budget ${d.context.budgetThreshold}%`);
  if (ctx.length) lines.push(`· ${ctx.join(", ")}`);

  if (lines.length === 1) lines.push("· quiet — no activity");
  // Never let a cap read as "that was everything".
  if (d.truncated) lines.push(`⚠ read capped at ${MAX_PAGES * PAGE_SIZE} events — counts are floors`);

  return lines.join("\n");
}

// --- Cursor + novelty state -------------------------------------------------

/**
 * One previously-reported window, kept so the next report has something to
 * judge itself against.
 *
 * Strangers only, and only the counts a narration would compare — this is a
 * baseline, not an archive. The full history of any window is re-derivable from
 * Cloud Logging and rendered by /r/<token>; what cannot be re-derived is which
 * windows were actually REPORTED, since they stretch across skipped runs and
 * swallow the whole overnight at 8am. That is why `hours` rides along: two
 * windows are only comparable through their durations.
 */
export interface RecentWindow {
  /** End of the window, ISO. Ordered oldest first in state. */
  to: string;
  hours: number;
  calls: number;
  workspaces: number;
  items: number;
  claims: number;
}

/** The baseline row for a window, from its anonymous digest. */
export function recentOf(d: Digest): RecentWindow {
  return {
    to: d.to.toISOString(),
    hours: Math.max(0, (d.to.getTime() - d.from.getTime()) / 3_600_000),
    calls: d.context.toolCalls,
    workspaces: d.workspaces.total,
    items: d.items.ok,
    claims: d.claims.count,
  };
}

export interface DigestState {
  cursor?: string;
  lastSentAt?: string;
  /** Baseline for the narrated SMS — see src/lib/funnel-narrator.ts. */
  recent?: RecentWindow[];
}

export async function readState(): Promise<DigestState> {
  const snap = await getFirestore().doc(STATE_DOC).get();
  return snap.exists ? (snap.data() as DigestState) : {};
}

export async function writeState(state: DigestState): Promise<void> {
  await getFirestore().doc(STATE_DOC).set(state, { merge: true });
}

export async function readSeen(): Promise<{ clientKinds: Set<string>; geos: Set<string> }> {
  const snap = await getFirestore().doc(SEEN_DOC).get();
  const data = snap.exists ? snap.data() : {};
  return {
    clientKinds: new Set<string>(data?.clientKinds ?? []),
    geos: new Set<string>(data?.geos ?? []),
  };
}

/**
 * Cached per-day rollup for the report page's 7-day trend.
 *
 * A completed PT day can never change, so re-querying six of them on every page
 * load is pure waste — that was most of the report's 7s render. Only today is
 * live. Counts only; the full aggregate is never stored.
 */
export interface DayRollup {
  toolCalls: number;
  workspaces: number;
  items: number;
  /** The anonymous share of the same three counts. */
  anonToolCalls: number;
  anonWorkspaces: number;
  anonItems: number;
}

/**
 * Schema version of a cached day.
 *
 * A cached day is immutable but its SHAPE isn't: v1 docs predate the
 * anonymous/signed-in split and have no way to supply it. Treating a stale
 * version as a miss re-aggregates that day once and rewrites it — self-healing,
 * and better than rendering a day's anonymous share as zero because the cache
 * couldn't answer.
 *
 * v3: MCP-only. v2 days counted console authoring in `items`, so leaving them
 * cached would draw a 7-day trend whose older bars mean something different
 * from its newer ones — the one way this cache can lie.
 */
const DAY_CACHE_VERSION = 3;

export async function readDayCache(date: string): Promise<DayRollup | null> {
  const snap = await getFirestore().collection("funnel-daily").doc(date).get();
  if (!snap.exists) return null;
  const d = snap.data() || {};
  if (typeof d.toolCalls !== "number" || d.v !== DAY_CACHE_VERSION) return null;
  return {
    toolCalls: d.toolCalls,
    workspaces: d.workspaces ?? 0,
    items: d.items ?? 0,
    anonToolCalls: d.anonToolCalls ?? 0,
    anonWorkspaces: d.anonWorkspaces ?? 0,
    anonItems: d.anonItems ?? 0,
  };
}

export async function writeDayCache(date: string, roll: DayRollup): Promise<void> {
  await getFirestore()
    .collection("funnel-daily")
    .doc(date)
    .set({ ...roll, v: DAY_CACHE_VERSION, cachedAt: new Date().toISOString() }, { merge: true });
}

/** The trend row for one day, from that day's split aggregate. */
export function rollupOf(split: SplitDigest): DayRollup {
  return {
    toolCalls: split.all.context.toolCalls,
    workspaces: split.all.workspaces.total,
    items: split.all.items.ok,
    anonToolCalls: split.anon.context.toolCalls,
    anonWorkspaces: split.anon.workspaces.total,
    anonItems: split.anon.items.ok,
  };
}

export async function writeSeen(seen: {
  clientKinds: Set<string>;
  geos: Set<string>;
}): Promise<void> {
  await getFirestore().doc(SEEN_DOC).set(
    { clientKinds: [...seen.clientKinds], geos: [...seen.geos] },
    { merge: true },
  );
}

/**
 * The window to report on.
 *
 * Starts at the last report's end so nothing is missed across a skipped or
 * failed run, and ends short of now so Cloud Logging ingestion lag can't clip
 * the tail. A missing cursor (first ever run) falls back to one hour.
 */
export function resolveWindow(state: DigestState, now = new Date()): { from: Date; to: Date } {
  const to = new Date(now.getTime() - INGEST_LAG_MS);
  const hourAgo = new Date(to.getTime() - 3_600_000);
  if (!COVER_SINCE_LAST_REPORT || !state.cursor) return { from: hourAgo, to };
  const cursor = new Date(state.cursor);
  return { from: Number.isNaN(cursor.getTime()) ? hourAgo : cursor, to };
}
