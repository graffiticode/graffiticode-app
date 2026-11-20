// The app's profileHealth (deploy.json): liveness, and the installation
// receipt when a profile is loaded (docs/installations-plan.md). gc-deploy
// reads it from a candidate and requires the receipt to match the revision's
// profile binding (appVersion, installation, repo, ref, digest), or, released
// without a profile, requires none.
//
// Uncached, and behind the installation guard the console's routes use
// (console/src/lib/with-installation.ts): if the profile can't be loaded the
// route answers 503 rather than report built-in policy.
import { NextResponse } from "next/server";
import { ensureInstallation } from "@graffiticode-app/core/profile/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  let receipt: ReturnType<typeof ensureInstallation>;
  try {
    receipt = ensureInstallation();
  } catch (err) {
    console.error(`[installation] ${(err as Error).message}`);
    return NextResponse.json({ error: "installation_unavailable" }, { status: 503, headers });
  }
  if (!receipt) return NextResponse.json({ ok: true }, { headers });
  headers["X-Installation"] = `${receipt.installationId}; profile=${receipt.profileDigest.slice(0, 12)}`;
  return NextResponse.json({ ok: true, installation: receipt }, { headers });
}
