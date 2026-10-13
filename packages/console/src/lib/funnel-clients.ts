// Which client kinds are prospects, which are machines, and which are us.
//
// A LEAF module on purpose: src/lib/funnel-digest.ts pulls in Firestore and a
// GCP token, and src/utils/db calls admin.initializeApp() at import time, so a
// script that imports the digest just to classify a name would initialise
// firebase-admin before setting GOOGLE_APPLICATION_CREDENTIALS — and then throw
// app/duplicate-app on its own init. Nothing here imports anything.

/**
 * Which side of the noise line a client falls on — the ONE place that decides.
 *
 * `crawler` is a client that SAYS it is one — directory audits, reputation
 * scanners, uptime probes, `Mozilla/`-shaped user agents pasted into
 * clientInfo. `internal` is us exercising our own server — the MCP Inspector
 * (the project's standard manual-testing app) plus our own named one-off
 * harnesses, see INTERNAL_NAMES. Everything else that gives a name is
 * an `agent`, including names we suspect are automated: `Anthropic/ClaudeAI` is
 * far and away the largest bucket and has never produced a tool call, but
 * guessing it into the bin would delete the evidence either way. It gets its
 * own row, and the mcp_listed column settles it — a validator handshakes and
 * stops, a host lists our tools.
 *
 * `unnamed` is its own bucket rather than folded into `agent`. Connects carried
 * no client_kind until 2026-07-28, so merging them would invent demand out of
 * data that predates the field.
 *
 * This vocabulary lived in TWO places until 2026-08-26: here (reach rows only,
 * word-boundary matching) and as loose substrings in
 * scripts/mcp-funnel-report.ts, which used it to exclude probes from its
 * success rate. The digest's not having it is why the hourly SMS reported
 * `adoption-verify`'s 40 tool calls as anonymous demand in the 08-19→26 week —
 * 47 of 136 tool calls that week were probes. That script now imports from
 * here, so a name learned in one surface is known to all four.
 */
export type ClientClass = "crawler" | "internal" | "agent" | "unnamed";

export function classifyClient(kind?: string): ClientClass {
  if (!kind) return "unnamed";
  const lower = kind.toLowerCase();
  if (INTERNAL_NAMES.has(lower) || INTERNAL_PATTERN.test(kind)) return "internal";
  if (CRAWLER_NAMES.has(lower)) return "crawler";
  return CRAWLER_PATTERN.test(kind) ? "crawler" : "agent";
}

/**
 * Back-compat name for the reach rows, which have no use for `internal` and
 * file it with the rest of the automated traffic.
 */
export function classifyConnect(kind?: string): "crawler" | "agent" | "unnamed" {
  const c = classifyClient(kind);
  return c === "internal" ? "crawler" : c;
}

/** True for traffic that is not a prospect: crawlers, probes, and our own tools. */
export function isProbeKind(kind?: string): boolean {
  const c = classifyClient(kind);
  return c === "crawler" || c === "internal";
}

/**
 * Exact names, lower-cased. This is where a name goes when it is unmistakably a
 * machine but contains no word that generalises — `adoption-verify` names
 * itself and nothing else, and inventing a \badoption\b rule to catch it would
 * bin a real client called `adoption-coach`.
 */
const CRAWLER_NAMES = new Set([
  "agent-tools.cloud",
  "forge-catalog-audit",
  "catalog-health",
  "census-probe",
  "mcp-reputation-scanner",
  "probe",
  // Migrated from scripts/mcp-funnel-report.ts, where they were substrings.
  "adoption-verify",
  "adoptsignal",
  "connectability",
  "dark-mcp",
  "leaktest",
  "atlas",
  "catalogue",
  "measurement",
  "health",
  "survey",
  "dump",
  // Named, not patterned: `\bresearch\b` also matches `research-assistant` and
  // `^catalog-` also matches `catalog-shopping-helper`, both of which are
  // plausible things for a customer to build on us. The prefix/word rules that
  // used to catch these lived in mcp-funnel-report, where a misfile only
  // shifted a bucket; here it would delete demand.
  "mcp-protections-research",
  "catalog-inspect",
  // camelCase defeats \bharvest\b, which would otherwise be a rule that never
  // fires against the only harvester we have actually seen.
  "mcpharvest",
]);

/**
 * Whole words only, and no bare "catalog" or "health".
 *
 * This pattern's job is to catch the NEXT crawler, not to re-catch the ones
 * already named above, and a loose substring match is how a real client called
 * something like "healthcare-tutor" would disappear into the automated line.
 * Misfiling is visible either way — the footnote names what it collapsed — but
 * the default should be to leave a client in the table. That is why the
 * substrings inherited from mcp-funnel-report arrive here either as whole words
 * or as exact names, never as bare `includes()`: `inspect` as a substring also
 * matches an inspection-checklist authoring agent, which is a plausible thing
 * for someone to build on us.
 *
 * The `catalog-` and `orb-` PREFIX rules inherited from mcp-funnel-report are
 * deliberately not carried over: `catalog-shopping-helper` is a plausible real
 * client, and every prefixed name actually observed (`catalog-health`,
 * `catalog-inspect`) is covered by name or by a whole word. Nothing named
 * `orb-*` has ever connected, so the rule is dropped rather than guessed at.
 */
const CRAWLER_PATTERN =
  /\b(scanner|crawler|spider|censys|probe|audit|healthcheck|uptime|monitor|beacon|detector|verifier|profiler|nuclei|reputation|harvest|inspect)\b|^Mozilla\//i;

/**
 * Our OWN one-off harnesses and debug clients, by exact name.
 *
 * These are `internal`, not `crawler`: they are us exercising the server, and
 * the report renders the two as separate buckets even though both are held out
 * of user traffic. Filing them under `crawler` would say a third party probed
 * us, which is the wrong story about our own afternoon.
 *
 * Exact names for the same reason `adoption-verify` is: none of these contains
 * a word that generalises safely. A `\bharness\b` or `\bdebug\b` rule would
 * also bin a customer's `debug-assistant`, and the cost of a misfile here is
 * deleting demand.
 *
 * Learned on 2026-09-03, reading 09-01: 20 of that day's 91 tool calls were
 * these three, counted as user demand, which made the next quiet day read as a
 * collapse in traffic rather than the absence of our own testing. Note this
 * does NOT cover `claude-code`/`firebase`, which is also us but is shaped
 * exactly like a real keyed customer — no name-based rule can separate those.
 */
const INTERNAL_NAMES = new Set([
  "perf-harness",
  "gc-widget-debug",
  "codex-list-languages-diagnostic",
]);

/**
 * MCP Inspector is the project's standard manual-testing app (see the repo's
 * CLAUDE.md), so every session from it is US exercising the server, not demand.
 * Left unclassified it lands in `other` and counts as user traffic: over
 * 2026-07-21→08-20 that was 24 creates, ~7% of all creates in the window.
 *
 * Checked BEFORE the crawler rules, because `andrax-mcp-inspector` matches
 * \binspect\b too and "ours" is the more specific answer.
 */
const INTERNAL_PATTERN = /\binspector\b/i;
