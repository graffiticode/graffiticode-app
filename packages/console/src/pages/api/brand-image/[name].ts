// The console's brand images at their fixed URLs (/favicon.png, /logo.png;
// rewritten here by next.config.mjs). With a profile: the installation's icon,
// as checked and pinned when it loaded (core/src/profile/assets.ts). Without
// one: this build's own file in public/, as before.
import type { NextApiRequest, NextApiResponse } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installationAsset, profile } from "@graffiticode-app/core/profile/runtime";
import { withInstallation } from "../../../lib/with-installation";

// Each fixed URL and the profile image it serves.
const IMAGES: Record<string, "icon"> = { "favicon.png": "icon", "logo.png": "icon" };

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const name = String(req.query.name ?? "");
  const kind = IMAGES[name];
  if (!kind) return res.status(404).end();
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).end();
  }
  let body: Uint8Array;
  let type: string;
  if (profile()) {
    const asset = installationAsset(kind);
    // A profile always has its icon (the schema requires it, and it was
    // checked at load); never fall back to the build's image for another brand.
    if (!asset) return res.status(500).json({ error: "brand_image_unavailable" });
    body = asset.bytes;
    type = asset.type;
  } else {
    body = readFileSync(join(process.cwd(), "public", name));
    type = "image/png";
  }
  res.setHeader("Content-Type", type);
  res.setHeader("Content-Length", String(body.length));
  res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method === "HEAD") return res.status(200).end();
  return res.status(200).send(Buffer.from(body));
}

export default withInstallation(handler);
