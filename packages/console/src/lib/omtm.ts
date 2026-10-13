// The two OMTMs, read from their sources.
//
// Canonical definitions: marketing/graffiticode-funnel-and-omtm-contract.md §4.
// This module is the only place the agent OMTM is computed — every surface
// (mcp-funnel-report.ts, the /r/<token> page, the hourly digest) calls it rather
// than deriving its own. A second, log-derived twin would drift and quietly
// become a rival candidate for the headline.

// From workspace-week, NOT workspace-registry: the registry pulls in Firestore
// via src/utils/db, whose module-load initializeApp() collides with a script
// that configures the SDK with its own credentials.
import {
  OMTM_CLOCK_START,
  isoWeek,
  isoWeekBounds,
  type FirstOutcome,
  type WorkspaceAuth,
} from "./workspace-week";

/**
 * A reportable number.
 *
 * owner/formula/window/source are REQUIRED, not optional: the instrumentation
 * spec says "a number without those four is not reportable", and making them
 * mandatory in the type turns that into a compile error rather than something a
 * reviewer has to notice.
 */
export interface Metric {
  name: string;
  value: string;
  owner: string;
  formula: string;
  window: string;
  source: string;
  note?: string;
}

export interface WeeklyNewCreatingWorkspaces {
  week: string;
  /** The published number: external, free-plan, non-internal. */
  published: number;
  /** Authenticated workspaces — a labelled diagnostic, not the headline. */
  authedDiagnostic: number;
  /** Rows suppressed as our own traffic. */
  internalExcluded: number;
  byClientKind: Record<string, number>;
  byOutcome: Record<string, number>;
  byGeo: Record<string, number>;
  byLang: Record<string, number>;
  /**
   * True for the first week the registry ran. Every workspace that already
   * existed reads as new that week — no backfill was performed, by decision.
   * Label it and drop it from trend lines.
   */
  isClockStartWeek: boolean;
}

/** Current ISO week, for a default report window. */
export const currentWeek = (now = new Date()) => isoWeek(now);

/**
 * Weekly New Creating Workspaces — the agent OMTM.
 *
 * Queried by the `firstCreateAttemptWeek` string the writer stamped rather than
 * a timestamp range: equality on one field is served by Firestore's automatic
 * single-field index (no composite index to deploy), and it cannot drift at a
 * week boundary because reader and writer call the same isoWeek().
 *
 * `auth` and `internal` are filtered in memory so one read yields the published
 * number, the authed diagnostic, and the internal count together.
 *
 * Takes the Firestore handle as a parameter: the report script builds its own
 * with explicit credentials, and importing the app's would fight it.
 */
export async function weeklyNewCreatingWorkspaces(
  db: FirebaseFirestore.Firestore,
  opts: { week: string },
): Promise<WeeklyNewCreatingWorkspaces> {
  const snap = await db
    .collection("workspaces")
    .where("firstCreateAttemptWeek", "==", opts.week)
    .get();

  const out: WeeklyNewCreatingWorkspaces = {
    week: opts.week,
    published: 0,
    authedDiagnostic: 0,
    internalExcluded: 0,
    byClientKind: {},
    byOutcome: {},
    byGeo: {},
    byLang: {},
    isClockStartWeek: opts.week === isoWeek(new Date(`${OMTM_CLOCK_START}T12:00:00Z`)),
  };

  const bump = (m: Record<string, number>, k: string | undefined) => {
    if (!k) return;
    m[k] = (m[k] ?? 0) + 1;
  };

  for (const doc of snap.docs) {
    if (doc.get("internal") === true) {
      out.internalExcluded++;
      continue;
    }
    const auth = doc.get("auth") as WorkspaceAuth | undefined;
    if (auth === "firebase") {
      out.authedDiagnostic++;
      continue;
    }
    out.published++;
    bump(out.byClientKind, (doc.get("clientKind") as string) || "unknown");
    bump(out.byOutcome, doc.get("firstOutcome") as FirstOutcome | undefined);
    bump(out.byGeo, doc.get("geoCountry") as string | undefined);
    bump(out.byLang, doc.get("lang") as string | undefined);
  }

  return out;
}

/** Cumulative non-internal free-plan workspaces since the clock started. */
export async function totalCreatingWorkspaces(
  db: FirebaseFirestore.Firestore,
): Promise<number> {
  const snap = await db
    .collection("workspaces")
    .where("firstCreateAttemptAt", ">=", new Date(`${OMTM_CLOCK_START}T00:00:00Z`))
    .get();
  return snap.docs.filter(
    (d) => d.get("internal") !== true && d.get("auth") !== "firebase",
  ).length;
}

/** The agent OMTM as a reportable row. */
export function agentOmtmMetric(w: WeeklyNewCreatingWorkspaces): Metric {
  const { start, end } = isoWeekBounds(w.week);
  return {
    name: "Weekly New Creating Workspaces",
    value: String(w.published),
    owner: "Jeff",
    formula:
      'distinct workspaces whose first-ever create_item attempt (any outcome) falls in the week, excluding internal',
    window: `${w.week} (${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}, UTC)`,
    source: "Firestore `workspaces` registry",
    note:
      "Free-plan workspaces only. Authenticated MCP callers are keyed by sha256(bearer) in MCP events " +
      "and cannot be joined to console events, so they are reported separately as a diagnostic " +
      "(contract §4, spec §D3).",
  };
}

/**
 * The partner OMTM. Not instrumented and never will be — it is a judgement
 * about a conversation (spec §4). It still gets a row: the scorecard shows
 * exactly two OMTMs, one per funnel, and dropping the one that has no feed is
 * how the two-funnel discipline decays.
 */
export function partnerOmtmMetric(input: {
  sessions?: number;
  logUrl?: string;
}): Metric {
  return {
    name: "Partner-Requested Product Sessions",
    value: input.sessions === undefined ? "—" : String(input.sessions),
    owner: "Jeff",
    formula:
      "qualifying provider conversations in the month — all four conditions in contract §4 " +
      "(ICP match, named agent job, identified product/exec owner, provider-initiated next step)",
    window: "calendar month",
    source: input.logUrl ?? "manual partner interview log — NOT instrumented",
    note:
      input.sessions === undefined
        ? "No value supplied. Pass --partner-sessions N from the interview log."
        : undefined,
  };
}
