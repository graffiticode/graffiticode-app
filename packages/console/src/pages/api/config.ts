// The installation's public configuration (installations plan, P3, slice 2):
// the allowlist core/src/profile/public-config.ts defines, built from the
// installation this server runs as. The browser loads it before initializing
// anything that depends on it. Never credentials or security policy.
import type { NextApiRequest, NextApiResponse } from "next";
import { buildPublicConfig } from "@graffiticode-app/core/profile/public-config-server";
import { withInstallation } from "../../lib/with-installation";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  res.setHeader("Cache-Control", "no-store");
  let config;
  try {
    config = buildPublicConfig();
  } catch (err) {
    // The browser shows a configuration error and initializes nothing.
    console.error(`[installation] ${(err as Error).message}`);
    return res.status(503).json({ error: "configuration_unavailable" });
  }
  return res.status(200).json(config);
}

export default withInstallation(handler);
