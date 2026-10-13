// Corpus sweep report page, opened from the weekly SMS link.
//
// An API route rather than a page under src/pages/, for the same reason as the funnel report:
// _app.tsx wraps every route except form/editor in AuthWrapper, and this has to open with no
// sign-in from a phone. next.config.mjs rewrites /s/:token here so the SMS URL stays short.
//
// The token is the capability — an HMAC over the run id plus an expiry (src/lib/report-link.ts).
// Unlike the funnel report, which re-aggregates live on each load, a sweep run is IMMUTABLE: it is
// the record of what 110 generations produced at one moment, and regenerating it would cost real
// money and answer a different question. So this reads the stored doc and renders it.
import type { NextApiRequest, NextApiResponse } from "next";
import { getFirestore } from "../../../utils/db";
import { verifySweepToken } from "../../../lib/report-link";
import { renderSweepMissing, renderSweepReport } from "../../../lib/sweep-report-html";
import type { SweepRun } from "../../../lib/corpus-sweep";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const send = (status: number, html: string) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    // Never cached or indexed: the URL is the credential.
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.status(status).send(html);
  };

  const raw = req.query.token;
  const token = Array.isArray(raw) ? raw[0] : raw;
  const runId = token ? verifySweepToken(token) : null;

  // One generic page for every failure — forged, malformed, expired, or missing — so a probe
  // learns nothing from the difference.
  if (!runId) return send(404, renderSweepMissing());

  try {
    const snap = await getFirestore().collection("corpus-sweep-runs").doc(runId).get();
    if (!snap.exists) return send(404, renderSweepMissing());
    return send(200, renderSweepReport(snap.data() as SweepRun));
  } catch (err: any) {
    console.error("[sweep-report] failed to render:", err?.message || err);
    return send(500, renderSweepMissing());
  }
}
