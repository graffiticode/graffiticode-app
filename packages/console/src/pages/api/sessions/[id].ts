import type { NextApiRequest, NextApiResponse } from "next";
import { authEndSession } from "../../../lib/sessions";

// DELETE: sign out one of the account's sessions. The page signs this browser's own session
// out through sign-out instead, which also clears the cookie.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "DELETE") {
    res.setHeader("Allow", "DELETE");
    return res.status(405).json({ status: "error", error: { message: "method not allowed" } });
  }
  const authorization = req.headers.authorization;
  if (!authorization) {
    return res.status(401).json({ status: "error", error: { message: "Must be signed in" } });
  }
  const id = req.query.id;
  if (typeof id !== "string" || !id) {
    return res.status(400).json({ status: "error", error: { message: "must provide an id" } });
  }
  const upstream = await authEndSession({ authorization, id });
  const body = await upstream.json().catch(() => ({}));
  return res.status(upstream.status).json(body);
}
