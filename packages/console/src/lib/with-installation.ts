// The installation guard for API and worker entry points (installations plan,
// P2, console loading). instrumentation.ts initializes the installation at
// startup; this makes each guarded route independent of whether its server
// bundle shares that module instance. ensureInstallation() loads at most once
// and then reuses the pinned profile. If the profile can't be loaded, the
// route answers 503 rather than run on built-in policy.
//
// The response names the installation and its profile digest
// (X-Installation), so an operator, or the production-build check, can see
// which profile a route ran with.
import type { NextApiHandler } from "next";
import { ensureInstallation } from "@graffiticode-app/core/profile/runtime";

export function withInstallation(handler: NextApiHandler): NextApiHandler {
  return async (req, res) => {
    let receipt: ReturnType<typeof ensureInstallation>;
    try {
      receipt = ensureInstallation();
    } catch (err) {
      console.error(`[installation] ${(err as Error).message}`);
      return res.status(503).json({ error: "installation_unavailable" });
    }
    if (receipt) res.setHeader("X-Installation", `${receipt.installationId}; profile=${receipt.profileDigest.slice(0, 12)}`);
    return handler(req, res);
  };
}
