// Pure week/identity helpers for the workspace registry.
//
// Deliberately DEPENDENCY-FREE. The writer (workspace-registry.ts) needs
// Firestore; the readers (omtm.ts, scripts/mcp-funnel-report.ts) must not import
// it, because src/utils/db calls admin.initializeApp() at module load and that
// fights a script that initializes the SDK with its own explicit credentials.
// Keeping these here lets both sides share ONE isoWeek — which is the point:
// the writer stamps firstCreateAttemptWeek and the reader queries it, so if the
// two computed weeks separately they would disagree at year boundaries.

/** First day the registry ran. Weeks at or before this are not trend data. */
export const OMTM_CLOCK_START = "2026-08-07";

export type WorkspaceAuth = "free" | "firebase";

/**
 * `pending` until generation finishes. `wall` is a create refused at the quota
 * gate — which counts: the contract counts ATTEMPTS, and a refusal is demand we
 * turned away. It is also the case that currently leaves no Firestore row at
 * all, since the gate throws before the item shell is written.
 */
export type FirstOutcome = "pending" | "ok" | "generation_failed" | "error" | "wall";

/**
 * ISO-8601 week of a UTC instant, e.g. "2026-W32".
 *
 * An ISO week belongs to the year holding its Thursday, so the last days of
 * December can fall in week 1 of the next year and vice versa.
 */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Shift to the Thursday of this week; its calendar year is the ISO year.
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** UTC [start, end) of an ISO week string, for range queries and labelling. */
export function isoWeekBounds(week: string): { start: Date; end: Date } {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) throw new Error(`Not an ISO week: ${week}`);
  const [, y, w] = m;
  // Jan 4th is always in ISO week 1.
  const jan4 = new Date(Date.UTC(Number(y), 0, 4));
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1));
  const start = new Date(week1Monday);
  start.setUTCDate(week1Monday.getUTCDate() + (Number(w) - 1) * 7);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);
  return { start, end };
}
