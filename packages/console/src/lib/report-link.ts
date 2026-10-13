// Signed report links.
//
// The hourly SMS carries a URL to the full report (src/pages/api/r/[token].ts).
// It has to open one-handed on a phone with no sign-in, so the URL itself is
// the capability: an HMAC over the window plus an expiry. Same idea as
// src/lib/claim-token.ts, but deliberately NOT a JWT — a JWT's base64 header and
// payload run ~200 chars, and every character competes with the digest text for
// the 160-char SMS segment. Base36 epochs plus a truncated MAC fit in ~40.
//
// Anyone holding a link can read that report, which is why links expire. The
// window is signed, so a holder can't widen it to scrape other periods.

import crypto from "crypto";

/** Links stop working after this. Long enough to scroll back, short enough to bound a leak. */
const TTL_MS = 30 * 24 * 3600 * 1000;

/** Bytes of HMAC kept. 10 bytes = 80 bits, far past forgery range for this. */
const SIG_BYTES = 10;

function signingKey(): string {
  // Reuses the job secret rather than adding another to rotate. Distinct from
  // FREE_PLAN_NAMESPACE_SALT on purpose: that one signs anonymous user-facing
  // sessions, this signs internal reporting.
  const key = process.env.REPORT_LINK_SECRET || process.env.INTERNAL_JOB_SECRET || "";
  if (!key) throw new Error("REPORT_LINK_SECRET/INTERNAL_JOB_SECRET is not configured");
  return key;
}

function macFor(body: string): string {
  return crypto
    .createHmac("sha256", signingKey())
    .update(body)
    .digest("base64url")
    .slice(0, Math.ceil((SIG_BYTES * 8) / 6));
}

/** Seconds since epoch, base36 — 7 chars instead of 10. */
function enc(ms: number): string {
  return Math.floor(ms / 1000).toString(36);
}

function dec(s: string): number {
  const n = parseInt(s, 36);
  return Number.isFinite(n) ? n * 1000 : NaN;
}

export function signReportToken(from: Date, to: Date, now = new Date()): string {
  const body = `${enc(from.getTime())}.${enc(to.getTime())}.${enc(now.getTime() + TTL_MS)}`;
  return `${body}.${macFor(body)}`;
}

export interface ReportWindow {
  from: Date;
  to: Date;
}

/**
 * Verify a token and return its window, or null.
 *
 * Returns null for every failure mode rather than throwing or distinguishing
 * them — the caller renders one generic page, so a probe learns nothing about
 * whether a token was malformed, forged, or merely expired.
 */
export function verifyReportToken(token: string, now = new Date()): ReportWindow | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [f, t, e, sig] = parts;
  const body = `${f}.${t}.${e}`;

  const expected = macFor(body);
  // Constant-time: both are fixed-length base64url of the same MAC.
  if (
    sig.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  ) {
    return null;
  }

  const from = dec(f);
  const to = dec(t);
  const exp = dec(e);
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(exp)) return null;
  if (now.getTime() > exp) return null;
  if (to <= from) return null;

  return { from: new Date(from), to: new Date(to) };
}

export function reportUrl(from: Date, to: Date, now = new Date()): string {
  const base = (process.env.CONSOLE_URL || "https://console.graffiticode.org").replace(/\/$/, "");
  return `${base}/r/${signReportToken(from, to, now)}`;
}

// ---- Corpus sweep runs -------------------------------------------------------------------------
//
// The funnel token signs a WINDOW because its report is rendered live from events. A sweep report
// addresses one stored run instead (corpus-sweep-runs/<id>), so the token signs that id. Same key,
// same MAC, same expiry — a second scheme would be a second thing to rotate.
//
// Run ids are `wk2957` or `full-<iso with : and . replaced>`, so they never contain a dot and the
// three-part split stays unambiguous.

export function signSweepToken(runId: string, now = new Date()): string {
  const body = `${runId}.${enc(now.getTime() + TTL_MS)}`;
  return `${body}.${macFor(body)}`;
}

/** Verify a sweep token and return its run id, or null. Null for every failure mode, as above. */
export function verifySweepToken(token: string, now = new Date()): string | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [runId, e, sig] = parts;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) return null;

  const expected = macFor(`${runId}.${e}`);
  if (
    sig.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  ) {
    return null;
  }

  const exp = dec(e);
  if (!Number.isFinite(exp) || now.getTime() > exp) return null;
  return runId;
}

export function sweepReportUrl(runId: string, now = new Date()): string {
  const base = (process.env.CONSOLE_URL || "https://console.graffiticode.org").replace(/\/$/, "");
  return `${base}/s/${signSweepToken(runId, now)}`;
}
