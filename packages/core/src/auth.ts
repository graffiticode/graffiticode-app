// Moved from pages/api/index.ts and pages/api/generate-job.ts (Phase 1: untangle
// inside the console). How a request's credentials become a Principal.
import { createClient } from "@graffiticode/auth/client";
import { coreConfig } from "./config.js";
import { getCredentialsForApiKey } from "./lib/api-credentials.js";
import { getFreePlanCredentials, isFreePlanRequest } from "./lib/free-plan-context.js";
import { checkBurstLimit, BURST } from "./lib/free-plan-throttle.js";
import type { AuthReplay } from "./lib/generation-queue.js";

// The auth service client, created on first use from the configured URL (and
// again if it changes), so importing core has no side effect.
let authClient: { url: string; client: ReturnType<typeof createClient> } | null = null;
function client() {
  const url = coreConfig().authUrl;
  if (!authClient || authClient.url !== url) authClient = { url, client: createClient(url) };
  return authClient.client;
}

// Normalizes any inbound credential into { uid, idToken }, where idToken is
// always a Firebase ID token (or signed JWT) suitable for forwarding to
// api.graffiticode.org. Inbound can be either a Firebase ID token or a raw
// Graffiticode api key — the api-key path exchanges via the auth service.
export async function authenticate(token: string): Promise<{ uid: string; idToken: string }> {
  try {
    const { uid } = await client().verifyToken(token);
    return { uid, idToken: token };
  } catch {
    const { uid, idToken } = await getCredentialsForApiKey(token);
    return { uid, idToken };
  }
}

export type Principal = {
  uid: string;
  token: string;
  freePlan?: boolean;
  sessionNamespace?: string;
  sessionUuid?: string;
};

export type RequestCredentials = {
  token?: string;
  freePlan?: boolean;
  sessionNamespace?: string;
  sessionUuid?: string;
};

export async function resolveAuth(ctx: RequestCredentials): Promise<Principal> {
  if (ctx.freePlan) {
    const { uid, idToken } = await getFreePlanCredentials();
    // A fresh object per request — resolvers may rebind sessionNamespace onto it
    // (adoptWorkspace) and that must not leak across requests.
    return {
      uid,
      token: idToken,
      freePlan: true,
      sessionNamespace: ctx.sessionNamespace,
      sessionUuid: ctx.sessionUuid,
    };
  }
  const { uid, idToken } = await authenticate(ctx.token);
  return { uid, token: idToken };
}

// The free-plan half of admitting a request: verifies its X-Free-Plan-Session
// and applies the burst guard to every free-plan surface, once, rather than
// resolver by resolver — reads, writes and anything added later are covered
// without having to remember to. Generously sized (see BURST.API); the actual
// budget is items, enforced at creation. Throws an error carrying `status` and
// `payload` for a rejected session (bad signature, expired, or raw uuid once
// signed sessions are required) or a rate-limit rejection.
export async function admitRequest(req: { headers: Record<string, unknown> }) {
  const freePlan = await isFreePlanRequest(req as any);
  if (freePlan.freePlan) {
    await checkBurstLimit(freePlan.sessionNamespace, BURST.API);
  }
  return freePlan;
}

// The generation worker acts as the caller from the credential replayed in its
// job payload, resolved exactly as a live request's would be.
export function principalFromReplay(replay: AuthReplay): Promise<Principal> {
  return replay.kind === "freePlan"
    ? resolveAuth({ freePlan: true, sessionNamespace: replay.sessionNamespace })
    : resolveAuth({ token: replay.token });
}
