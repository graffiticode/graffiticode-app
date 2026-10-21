import type { NextApiRequest, NextApiResponse } from "next";
import { readSsoCookie } from "@graffiticode/auth-react/server";
import { authListSessions, authEndOtherSessions } from "../../../lib/sessions";

// GET: the account's sessions, with this browser's marked `current` (auth reads the SSO
// cookie's refresh token, which the browser itself can't). DELETE: sign out every session
// but this browser's. The caller's own token is passed through for auth to check.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const authorization = req.headers.authorization;
  if (!authorization) {
    return res.status(401).json({ status: "error", error: { message: "Must be signed in" } });
  }
  const refreshToken = readSsoCookie(req.headers.cookie);
  let upstream: Response;
  if (req.method === "GET") {
    upstream = await authListSessions({ authorization, refreshToken });
  } else if (req.method === "DELETE") {
    if (!refreshToken) {
      return res.status(400).json({ status: "error", error: { message: "This browser has no session to keep; sign out instead" } });
    }
    upstream = await authEndOtherSessions({ authorization, refreshToken });
  } else {
    res.setHeader("Allow", "GET, DELETE");
    return res.status(405).json({ status: "error", error: { message: "method not allowed" } });
  }
  const body = await upstream.json().catch(() => ({}));
  return res.status(upstream.status).json(body);
}
