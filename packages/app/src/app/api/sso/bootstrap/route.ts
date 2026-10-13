import { NextRequest, NextResponse } from "next/server";
import {
  readSsoCookie,
  bootstrapFirebaseToken,
  buildClearSsoCookie,
} from "@graffiticode/auth-react/server";

export const runtime = "nodejs";

// GET: exchange the shared SSO cookie for a fresh Firebase custom token so a
// user signed in on a sibling app is silently signed in here too. Returns an
// empty object (200) when there's no usable session.
export async function GET(req: NextRequest) {
  const refreshToken = readSsoCookie(req.headers.get("cookie"));
  if (!refreshToken) {
    return NextResponse.json({});
  }
  const firebaseCustomToken = await bootstrapFirebaseToken(refreshToken);
  if (!firebaseCustomToken) {
    // The cookie is stale/revoked — clear it so we don't retry on every load.
    const res = NextResponse.json({});
    res.headers.set("Set-Cookie", buildClearSsoCookie());
    return res;
  }
  return NextResponse.json({ firebaseCustomToken });
}
