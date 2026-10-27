// Render -> outcome correlation (P1 #2, part C).
//
// render_item answers `ready` with a per-call render_id (mcp_tool event,
// `render`); the widget then reports its terminal outcome on a beacon carrying
// the same id (`[widget] beacon stage=outcome … rid=<id> outcome=mounted|card`).
// A ready render on a host that mounts widgets with no outcome beacon means the
// user may have seen nothing — the failure mode that went unnoticed before
// (an item delivered, nothing shown). This joins the two, every 15 minutes, for
// renders between 75 and 15 minutes ago (late enough for a beacon to arrive).
//
// Attribution rules:
//   - a ready render is CONFIRMED only by an outcome beacon carrying its rid;
//   - an outcome beacon without a rid (an old cached widget) can't be tied to
//     any render: counted as `legacyUnattributable`, it never confirms one;
//   - `outcome=card` where a native mount was expected is reported (`card`);
//   - "unconfirmed" means no beacon arrived, not that nothing appeared: the
//     beacon itself can be lost.
//
// Baseline (2026-10-20..27): 31 ready renders on rendering hosts, 27 mounted,
// 1 card, 3 unconfirmed (10%), at about 0.2 renders an hour.

import { getAccessToken } from "@graffiticode-app/core/lib/gcp-token";

const PROJECT =
  process.env.GENERATION_QUEUE_PROJECT ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCLOUD_PROJECT ||
  "graffiticode-app";
const MCP_SERVICE = "mcp-service";

// Hosts that mount the widget, so a ready render should produce an outcome
// beacon. The same set as packages/mcp-server/src/tools.ts RENDERING_HOSTS;
// keep them together.
export const RENDERING_HOSTS: ReadonlySet<string> = new Set([
  "openai-mcp",
  "openai-mcp (Codex)",
  "Anthropic/ClaudeAI",
  "claude-ai",
]);

export const WINDOW_START_MIN = 75;
export const WINDOW_END_MIN = 15;
export const BEACON_SLACK_S = 60;
export const RELEASE_GRACE_MIN = 60;

export interface Render { rid: string; at: string; clientKind: string; lang?: string; item?: string }
export interface Beacon { stage: string; lang?: string; rid?: string; outcome?: string; wv?: string; current?: string }

// A beacon line's fields are space-separated key=value pairs, in no fixed
// order (`lang=` comes between `stage=` and `rid=`): parse them, never match
// a contiguous pattern.
export function parseBeacon(text: string): Beacon | null {
  const at = text.indexOf("[widget] beacon ");
  if (at < 0) return null;
  const fields: Record<string, string> = {};
  for (const token of text.slice(at + "[widget] beacon ".length).trim().split(/\s+/)) {
    const eq = token.indexOf("=");
    if (eq > 0) fields[token.slice(0, eq)] = token.slice(eq + 1);
  }
  if (!fields.stage) return null;
  return { stage: fields.stage, lang: fields.lang, rid: fields.rid, outcome: fields.outcome, wv: fields.wv, current: fields.current };
}

export interface Correlation {
  renders: number;
  confirmed: number;
  unconfirmed: number;
  card: number;
  legacyUnattributable: number;
  unconfirmedRenders: Render[];
}

export function correlate(renders: Render[], beacons: Beacon[]): Correlation {
  const outcomes = new Map<string, Set<string>>();
  let legacyUnattributable = 0;
  for (const b of beacons) {
    if (b.stage !== "outcome") continue;
    if (!b.rid) { legacyUnattributable++; continue; }
    if (!outcomes.has(b.rid)) outcomes.set(b.rid, new Set());
    outcomes.get(b.rid)!.add(b.outcome ?? "");
  }
  let confirmed = 0;
  let card = 0;
  const unconfirmedRenders: Render[] = [];
  for (const r of renders) {
    const seen = outcomes.get(r.rid);
    if (seen?.has("mounted")) confirmed++;
    else if (seen?.has("card")) card++;
    else unconfirmedRenders.push(r);
  }
  return { renders: renders.length, confirmed, card, unconfirmed: unconfirmedRenders.length, legacyUnattributable, unconfirmedRenders };
}

// Alert when 3 or more ready renders in the window went unconfirmed, or more
// than 20% of at least 5. Never inside the grace period after an mcp-service
// release, when widgets reload and beacons are unreliable (the counts are still
// logged).
export function shouldAlert(c: Pick<Correlation, "renders" | "unconfirmed">, inGrace: boolean): boolean {
  if (inGrace) return false;
  return c.unconfirmed >= 3 || (c.renders >= 5 && c.unconfirmed / c.renders > 0.2);
}

export function formatAlert(c: Correlation, from: Date, to: Date): string {
  const ids = c.unconfirmedRenders.slice(0, 3).map((r) => `${r.lang ?? "?"} ${r.rid.slice(0, 8)}`).join(", ");
  return `Graffiticode: ${c.unconfirmed} of ${c.renders} widget renders unconfirmed (no outcome beacon), ` +
    `${from.toISOString().slice(11, 16)}-${to.toISOString().slice(11, 16)}Z. ${ids}`;
}

// --- Cloud Logging ----------------------------------------------------------

type Entry = { timestamp?: string; textPayload?: string; jsonPayload?: Record<string, unknown> };

async function listEntries(filter: string, maxPages = 10): Promise<Entry[]> {
  const token = await getAccessToken();
  const out: Entry[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const res = await fetch("https://logging.googleapis.com/v2/entries:list", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ resourceNames: [`projects/${PROJECT}`], filter, orderBy: "timestamp asc", pageSize: 1000, ...(pageToken ? { pageToken } : {}) }),
    });
    if (!res.ok) throw new Error(`logging entries:list failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
    const json = (await res.json()) as { entries?: Entry[]; nextPageToken?: string };
    out.push(...(json.entries ?? []));
    pageToken = json.nextPageToken;
    pages++;
  } while (pageToken && pages < maxPages);
  return out;
}

const range = (from: Date, to: Date) => `timestamp >= "${from.toISOString()}" AND timestamp < "${to.toISOString()}"`;

export async function fetchReadyRenders(from: Date, to: Date): Promise<Render[]> {
  const entries = await listEntries([
    range(from, to),
    `resource.labels.service_name="${MCP_SERVICE}"`,
    `jsonPayload.ev="mcp_tool"`, `jsonPayload.tool="render_item"`, `jsonPayload.status="ready"`, `jsonPayload.render:*`,
  ].join(" AND "));
  const renders: Render[] = [];
  for (const e of entries) {
    const p = e.jsonPayload ?? {};
    const clientKind = String(p.client_kind ?? "");
    if (!RENDERING_HOSTS.has(clientKind) || typeof p.render !== "string") continue;
    renders.push({ rid: p.render, at: String(e.timestamp ?? p.t ?? ""), clientKind, lang: typeof p.lang === "string" ? p.lang : undefined, item: typeof p.item === "string" ? p.item : undefined });
  }
  return renders;
}

export async function fetchOutcomeBeacons(from: Date, to: Date): Promise<Beacon[]> {
  const entries = await listEntries([
    range(from, to),
    `resource.labels.service_name="${MCP_SERVICE}"`,
    `textPayload:"[widget] beacon stage=outcome"`,
  ].join(" AND "));
  return entries.map((e) => parseBeacon(e.textPayload ?? "")).filter((b): b is Beacon => !!b);
}

// An mcp-service rollout (a new revision's first instance) within the grace
// period before `now`.
export async function inReleaseGrace(now: Date): Promise<boolean> {
  const entries = await listEntries([
    range(new Date(now.getTime() - RELEASE_GRACE_MIN * 60_000), now),
    `resource.labels.service_name="${MCP_SERVICE}"`,
    `textPayload:"DEPLOYMENT_ROLLOUT"`,
  ].join(" AND "), 1);
  return entries.length > 0;
}

export interface CheckResult extends Correlation {
  from: string;
  to: string;
  inGrace: boolean;
  alert: boolean;
  test?: { injected: number; nonce: string };
}

// A test run (P1 #2 E): `injectUnconfirmed` synthetic renders with no beacon
// (rid `test-<nonce>-<n>`, never a real render id) join the real ones, so the
// alert path runs end to end. The grace period doesn't hold a test back.
export interface CheckOptions { injectUnconfirmed?: number; nonce?: string }

export function syntheticRenders(n: number, nonce: string, at: Date): Render[] {
  return Array.from({ length: n }, (_, i) => ({ rid: `test-${nonce}-${i + 1}`, at: at.toISOString(), clientKind: "test (P1 #2 E)" }));
}

export async function runCheck(now: Date, { injectUnconfirmed = 0, nonce = "" }: CheckOptions = {}): Promise<CheckResult> {
  const from = new Date(now.getTime() - WINDOW_START_MIN * 60_000);
  const to = new Date(now.getTime() - WINDOW_END_MIN * 60_000);
  const [renders, beacons, inGrace] = await Promise.all([
    fetchReadyRenders(from, to),
    fetchOutcomeBeacons(from, new Date(Math.min(now.getTime(), to.getTime() + (WINDOW_END_MIN * 60 + BEACON_SLACK_S) * 1000))),
    inReleaseGrace(now),
  ]);
  const test = injectUnconfirmed > 0;
  const c = correlate(test ? [...renders, ...syntheticRenders(injectUnconfirmed, nonce, to)] : renders, beacons);
  return {
    ...c, from: from.toISOString(), to: to.toISOString(), inGrace,
    alert: shouldAlert(c, test ? false : inGrace),
    ...(test ? { test: { injected: injectUnconfirmed, nonce } } : {}),
  };
}
