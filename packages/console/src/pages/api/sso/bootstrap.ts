import type { NextApiRequest, NextApiResponse } from "next";
import {
  readSsoCookie,
  bootstrapFirebaseToken,
  buildClearSsoCookie,
} from "@graffiticode/auth-react/server";

// GET: exchange the shared SSO cookie for a fresh Firebase custom token so a
// user signed in on a sibling app is silently signed in here too. Returns an
// empty object (200) when there's no usable session.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({});
  }
  const refreshToken = readSsoCookie(req.headers.cookie);
  if (!refreshToken) {
    return res.status(200).json({});
  }
  const firebaseCustomToken = await bootstrapFirebaseToken(refreshToken);
  if (!firebaseCustomToken) {
    // The cookie is stale/revoked — clear it so we don't retry on every load.
    res.setHeader("Set-Cookie", buildClearSsoCookie());
    return res.status(200).json({});
  }
  return res.status(200).json({ firebaseCustomToken });
}
