import type { NextApiRequest, NextApiResponse } from "next";
import { buildSetSsoCookie, buildClearSsoCookie, readSsoCookie } from "@graffiticode/auth-react/server";
import { revokeSession } from "../../../lib/sessions";

// POST: store the auth-service refresh token in the shared .graffiticode.org SSO
// cookie after a successful sign-in. DELETE: on sign-out, end the cookie's session
// at the auth service (so the token stops working, not just this browser's copy),
// then clear the cookie (single sign-out across console.graffiticode.org and
// app.graffiticode.org).
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "POST") {
    const refreshToken = req.body?.refreshToken;
    if (typeof refreshToken !== "string" || !refreshToken) {
      return res.status(400).json({ ok: false, error: "refreshToken required" });
    }
    res.setHeader("Set-Cookie", buildSetSsoCookie(refreshToken));
    return res.status(200).json({ ok: true });
  }
  if (req.method === "DELETE") {
    const refreshToken = readSsoCookie(req.headers.cookie);
    if (refreshToken) await revokeSession(refreshToken);
    res.setHeader("Set-Cookie", buildClearSsoCookie());
    return res.status(200).json({ ok: true });
  }
  res.setHeader("Allow", "POST, DELETE");
  return res.status(405).json({ ok: false, error: "method not allowed" });
}
