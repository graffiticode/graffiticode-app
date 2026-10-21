import { NextRequest, NextResponse } from "next/server";
import { buildSetSsoCookie, buildClearSsoCookie, readSsoCookie, revokeSsoSession } from "@graffiticode/auth-react/server";

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

// DELETE: on sign-out, end the cookie's session at the auth service, then clear
// the shared SSO cookie (single sign-out).
export async function DELETE(req: NextRequest) {
  const refreshToken = readSsoCookie(req.headers.get("cookie"));
  if (refreshToken) await revokeSsoSession(refreshToken);
  const res = NextResponse.json({ ok: true });
  res.headers.set("Set-Cookie", buildClearSsoCookie());
  return res;
}
