import type { NextApiRequest, NextApiResponse } from "next";
import { buildSetSsoCookie, buildClearSsoCookie } from "@graffiticode/auth-react/server";

// POST: store the auth-service refresh token in the shared .graffiticode.org SSO
// cookie after a successful sign-in. DELETE: clear it on sign-out (single
// sign-out across console.graffiticode.org and app.graffiticode.org).
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "POST") {
    const refreshToken = req.body?.refreshToken;
    if (typeof refreshToken !== "string" || !refreshToken) {
      return res.status(400).json({ ok: false, error: "refreshToken required" });
    }
    res.setHeader("Set-Cookie", buildSetSsoCookie(refreshToken));
    return res.status(200).json({ ok: true });
  }
  if (req.method === "DELETE") {
    res.setHeader("Set-Cookie", buildClearSsoCookie());
    return res.status(200).json({ ok: true });
  }
  res.setHeader("Allow", "POST, DELETE");
  return res.status(405).json({ ok: false, error: "method not allowed" });
}
