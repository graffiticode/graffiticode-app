import type { NextApiRequest, NextApiResponse } from "next";
import { verifyClaimToken } from "../../lib/claim-token";
import { logClaimStage, type ClaimStage } from "./resolvers";

// Three surfaces can offer a claim, and each mints its own value:
//   chat    the claim_url an agent prints in the conversation
//   widget  the MCP widget's in-host footer button (mcp-server, claim_url_widget)
//   footer  the app's /form attribution bar (app, FormFooter, via view_url's ?claim=)
// `unknown` is the honest answer for a link that carried no src — which is what
// the app footer sent for its first three months.
const ALLOWED_SRC = new Set(["chat", "widget", "footer", "unknown"]);

// Stages of the pre-sign-in claim funnel this endpoint will record. Allowlisted
// rather than passed through, for the same reason `src` is: the body is
// unauthenticated, so anything it names has to be a value we chose. An absent or
// unrecognised stage is the original behaviour, a view.
const ALLOWED_STAGE = new Set<ClaimStage>(["view", "auth_shown", "email_submitted"]);

/**
 * Records a stage of the claim funnel — opened, offered sign-in, submitted email.
 *
 * Fires before sign-in — that's the point, since the drop-off being measured is
 * between opening the link and completing an account. So it can't ride on the
 * authenticated GraphQL path.
 *
 * The request body carries no email address and must not start doing so: the
 * later stages report that a step was REACHED, never what was typed into it.
 *
 * The token is VERIFIED rather than trusted, for two reasons: it yields the real
 * sessionNamespace, which is what the funnel report joins on, and it means the
 * endpoint can't be used to write arbitrary sessions into the log. An invalid
 * token is answered 204 all the same — this is telemetry, and a caller has
 * nothing to learn from us about why a token didn't verify.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const { token, src, stage } = (req.body || {}) as {
    token?: string;
    src?: string;
    stage?: string;
  };
  if (!token) {
    res.status(204).end();
    return;
  }

  try {
    const { sessionNamespace } = await verifyClaimToken(token);
    logClaimStage({
      stage: ALLOWED_STAGE.has(stage as ClaimStage) ? (stage as ClaimStage) : "view",
      session: sessionNamespace,
      src: ALLOWED_SRC.has(String(src)) ? String(src) : "unknown",
    });
  } catch {
    // Expired or forged token — nothing to record, and nothing to report.
  }

  res.status(204).end();
}
