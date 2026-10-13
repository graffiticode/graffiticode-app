import { NextRequest, NextResponse } from "next/server";
import { buildSetSsoCookie, buildClearSsoCookie } from "@graffiticode/auth-react/server";

export const runtime = "nodejs";

// POST: store the auth-service refresh token in the shared .graffiticode.org
// SSO cookie after a successful sign-in.
export async function POST(req: NextRequest) {
  let refreshToken: unknown;
  try {
    refreshToken = (await req.json())?.refreshToken;
  } catch {
    refreshToken = undefined;
  }
  if (typeof refreshToken !== "string" || !refreshToken) {
    return NextResponse.json({ ok: false, error: "refreshToken required" }, { status: 400 });
  }
  const res = NextResponse.json({ ok: true });
  res.headers.set("Set-Cookie", buildSetSsoCookie(refreshToken));
  return res;
}

// DELETE: clear the shared SSO cookie on sign-out (single sign-out).
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.headers.set("Set-Cookie", buildClearSsoCookie());
  return res;
}
