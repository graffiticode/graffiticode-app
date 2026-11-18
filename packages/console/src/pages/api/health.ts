// Liveness for gc-deploy's smoke check (2xx, no auth, no redirect). With
// ?deep=1 it also reads core's generation-protocol floor from Firestore and
// reports the effective protocol, which the release verify step checks against
// system/generation-protocol.minProtocol (app tier Phase 3.5).
import type { NextApiRequest, NextApiResponse } from "next";
import { effectiveProtocol } from "@graffiticode-app/core/generation-protocol";
import { installationReceipt } from "@graffiticode-app/core/profile/runtime";
import { withInstallation } from "../../lib/with-installation";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.query.deep !== "1") {
    // The installation receipt, when a profile is loaded (docs/installations-plan.md).
    const receipt = installationReceipt();
    return res.status(200).json(receipt ? { ok: true, installation: receipt } : { ok: true });
  }
  try {
    const protocol = await effectiveProtocol();
    return res.status(200).json({
      ok: true,
      generationProtocol: protocol.configured,
      minProtocol: protocol.minProtocol,
      effectiveProtocol: protocol.effective,
    });
  } catch (err) {
    console.error("[health] deep check failed", err);
    return res.status(503).json({ ok: false, error: "deep_check_failed" });
  }
}

export default withInstallation(handler);
