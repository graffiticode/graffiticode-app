// The app's brand image at its fixed URL (/icon.png; rewritten here by
// next.config.js). With a profile: the installation's icon, as checked and
// pinned when it loaded (core/src/profile/assets.ts). Without one: this
// build's own public/icon.png, as before.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureInstallation, installationAsset, profile } from "@graffiticode-app/core/profile/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IMAGES: Record<string, "icon"> = { "icon.png": "icon" };

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const kind = IMAGES[name];
  if (!kind) return new Response(null, { status: 404 });
  try {
    ensureInstallation();
  } catch (err) {
    console.error(`[installation] ${(err as Error).message}`);
    return Response.json({ error: "installation_unavailable" }, { status: 503 });
  }
  let body: Uint8Array;
  let type: string;
  if (profile()) {
    const asset = installationAsset(kind);
    // A profile always has its icon; never fall back to the build's image.
    if (!asset) return Response.json({ error: "brand_image_unavailable" }, { status: 500 });
    body = asset.bytes;
    type = asset.type;
  } else {
    body = readFileSync(join(process.cwd(), "public", name));
    type = "image/png";
  }
  return new Response(Buffer.from(body), {
    headers: {
      "Content-Type": type,
      "Content-Length": String(body.length),
      "Cache-Control": "public, max-age=0, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
