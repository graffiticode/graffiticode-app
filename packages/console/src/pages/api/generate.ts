import type { NextApiRequest, NextApiResponse } from "next";
import { generateCodeForRequest } from "@graffiticode-app/core/lib/code-generation/generate-for-request";
import { admitRequest, resolveAuth } from "@graffiticode-app/core/auth";
import { respondWithKeepalive } from "../../lib/keepalive-json";

// The console's code generation, as the GraphQL `generateCode` mutation does it, over a response
// that survives Cloudflare's 100 s limit (see lib/keepalive-json.ts). A long L0187 brief ran 3+
// minutes on 2026-11-02 and the browser got a 524 while the server finished and threw the
// result away. Same inputs, same auth, same result shape as the mutation, so the chat and the
// editor handle the answer exactly as before.
export const config = { api: { responseLimit: false } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }
  // Admission and authentication fail fast, with real statuses, before the keep-alive starts.
  let freePlan: Awaited<ReturnType<typeof admitRequest>>;
  try {
    freePlan = await admitRequest(req);
  } catch (err: any) {
    res.status(err?.status || 401).json(err?.payload || { error: "free_plan_session_invalid" });
    return;
  }
  let auth;
  try {
    auth = await resolveAuth({
      token: req.headers.authorization,
      freePlan: freePlan.freePlan,
      sessionUuid: freePlan.freePlan ? freePlan.sessionUuid : undefined,
      sessionNamespace: freePlan.freePlan ? freePlan.sessionNamespace : undefined,
    } as any);
  } catch (err: any) {
    res.status(401).json({ error: "unauthorized", message: err?.message });
    return;
  }

  const { prompt, language, options, currentSrc, currentData, conversationSummary, itemId } = req.body || {};
  if (typeof prompt !== "string" || !prompt || typeof language !== "string" || !language) {
    res.status(400).json({ error: "prompt and language are required" });
    return;
  }
  // As in the mutation: the compiled data is context only, and unparseable means none.
  let parsedCurrentData: unknown = null;
  if (typeof currentData === "string" && currentData.length > 0) {
    try {
      parsedCurrentData = JSON.parse(currentData);
    } catch {
      parsedCurrentData = null;
    }
  }

  await respondWithKeepalive(res, () =>
    generateCodeForRequest({
      auth,
      prompt,
      language,
      options,
      currentSrc,
      currentData: parsedCurrentData,
      conversationSummary,
      itemId,
    }),
  );
}
