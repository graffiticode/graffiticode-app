// The installation's public configuration (installations plan, P3, slice 2):
// the allowlist core/src/profile/public-config.ts defines, built from the
// installation this server runs as. Never credentials or security policy.
import { NextResponse } from "next/server";
import { ensureInstallation } from "@graffiticode-app/core/profile/runtime";
import { buildPublicConfig } from "@graffiticode-app/core/profile/public-config-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const noStore = { "Cache-Control": "no-store" };
  try {
    ensureInstallation();
    return NextResponse.json(buildPublicConfig(), { headers: noStore });
  } catch (err) {
    // The browser shows a configuration error and initializes nothing.
    console.error(`[installation] ${(err as Error).message}`);
    return NextResponse.json({ error: "configuration_unavailable" }, { status: 503, headers: noStore });
  }
}
