import type { NextApiRequest, NextApiResponse } from "next";
import bent from "bent";
import { getBaseUrlForApi } from "../../lib/api";
import { client as authClient } from "../../lib/auth";
import { getCredentialsForApiKey } from "../../lib/api-credentials";
import { getFreePlanCredentials, isFreePlanRequest } from "../../lib/free-plan-context";
import { checkBurstLimit, BURST } from "../../lib/free-plan-throttle";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Free-Plan-Session");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  let freePlan: Awaited<ReturnType<typeof isFreePlanRequest>>;
  try {
    freePlan = await isFreePlanRequest(req);
    // This proxy reaches a compiler service, and until now nothing bounded how
    // often an anonymous caller could do that.
    if (freePlan.freePlan) {
      await checkBurstLimit(freePlan.sessionNamespace, BURST.COMPILE);
    }
  } catch (err) {
    const status = (err as any)?.status || 401;
    const payload = (err as any)?.payload || { error: "free_plan_session_invalid" };
    res.status(status).json(payload);
    return;
  }
  const incomingAuth = (req.headers.authorization as string) || "";
  let downstreamAuth: string;

  if (freePlan.freePlan) {
    try {
      const { idToken } = await getFreePlanCredentials();
      downstreamAuth = idToken;
    } catch (err) {
      res.status(500).json({ error: "free_plan_misconfigured", message: err instanceof Error ? err.message : String(err) });
      return;
    }
  } else {
    if (!incomingAuth) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    // If incomingAuth is a Firebase ID token / signed JWT, forward as-is.
    // If it's a raw api key, exchange it for a Firebase ID token first
    // (api.graffiticode.org's auth middleware doesn't accept raw api keys).
    try {
      await authClient.verifyToken(incomingAuth);
      downstreamAuth = incomingAuth;
    } catch {
      try {
        const { idToken } = await getCredentialsForApiKey(incomingAuth);
        downstreamAuth = idToken;
      } catch (err) {
        res.status(401).json({ error: "invalid_credential", message: err instanceof Error ? err.message : String(err) });
        return;
      }
    }
  }

  // A free-plan compile runs under the shared trial account, which owns no
  // connection: it never runs through one.
  if (freePlan.freePlan && req.body && typeof req.body === "object") {
    delete req.body.connectionId;
    delete req.body.idempotencyKey;
  }
  try {
    const headers = {
      authorization: downstreamAuth,
      "x-graffiticode-storage-type": "persistent",
    };
    const post = bent(getBaseUrlForApi(), "POST", "json", headers);
    const resp = await post("/compile", req.body);
    res.status(200).json(resp);
  } catch (err: any) {
    const status = typeof err?.statusCode === "number" ? err.statusCode : 502;
    let body: unknown = { error: "compile_proxy_failed", message: err?.message };
    if (typeof err?.json === "function") {
      try {
        body = await err.json();
      } catch {
        // fall back to default body
      }
    }
    res.status(status).json(body);
  }
}
