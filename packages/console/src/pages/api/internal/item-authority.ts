// POST /api/internal/item-authority { itemId }: who owns one item and whether
// it is public, for Graffiticode's Policy service only (src/lib/item-authority.ts).
//
//   ITEM_AUTHORITY_AUDIENCE  the audience Policy's ID token must be issued for
//                            (default: https://console.graffiticode.org/api/internal/item-authority)
//   ITEM_AUTHORITY_CALLERS   comma-separated service accounts allowed
//                            (default: policy-run@graffiticode.iam.gserviceaccount.com)
//
// Policy treats any answer but 200 as "item authority unavailable": temporary,
// and never allowing. So does a refused caller here; nothing is said about
// the item.
import type { NextApiRequest, NextApiResponse } from "next";
import { OAuth2Client } from "google-auth-library";
import { getFirestore } from "@graffiticode-app/core/utils/db/index";
import {
  CallerRefused,
  DEFAULT_AUDIENCE,
  ITEM_ID_RE,
  firestoreItems,
  itemAuthorityAnswer,
  parseCallers,
  verifyCaller,
} from "../../../lib/item-authority";

const client = new OAuth2Client();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const audience = process.env.ITEM_AUTHORITY_AUDIENCE || DEFAULT_AUDIENCE;
  try {
    await verifyCaller({
      authorization: req.headers.authorization,
      audience,
      callers: parseCallers(process.env.ITEM_AUTHORITY_CALLERS),
      verifyIdToken: async ({ idToken, audience: aud }) => (await client.verifyIdToken({ idToken, audience: aud })).getPayload(),
    });
  } catch (e) {
    if (e instanceof CallerRefused) return res.status(403).json({ error: "Forbidden" });
    throw e;
  }
  const itemId = req.body?.itemId;
  if (typeof itemId !== "string" || !ITEM_ID_RE.test(itemId)) return res.status(400).json({ error: "itemId is required" });
  try {
    return res.status(200).json(await itemAuthorityAnswer({ itemId, findItems: firestoreItems(getFirestore()) }));
  } catch (err) {
    console.error("item-authority: lookup failed", itemId, err);
    return res.status(503).json({ error: "Unavailable" });
  }
}
