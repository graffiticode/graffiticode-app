// Who is calling. Two kinds of credential, as MCP has:
//   Authorization: Bearer <Graffiticode API key or Firebase ID token>
//   X-Graffiticode-Workspace: <free-plan workspace token>
// resolved by core exactly as the console resolves them. OAuth access tokens
// (gcmcp_at_…) come with P4c, once the authorization server accepts this API
// as a resource. Credentials are also what's forwarded to the console for the
// one call that runs there (get_spec).
import type { Context } from "hono";
import { admitRequest, resolveAuth, type Principal, type RequestCredentials } from "@graffiticode-app/core/auth";
import { mintSessionToken } from "@graffiticode-app/core/lib/free-plan-session-token";
import { ApiProblem } from "./problems.js";
import { fromCoreError } from "./errors.js";

export type Caller = {
  ctx: RequestCredentials & { clientKind?: string };
  // Headers that carry the same identity to the console's GraphQL endpoint.
  forward: Record<string, string>;
  principal: () => Promise<Principal>;
};

const challenge = () => new ApiProblem(401, "unauthenticated", "Credentials required", {
  detail: "Send `Authorization: Bearer <API key>`, or a free-plan workspace token as `X-Graffiticode-Workspace` (from POST /workspaces).",
  headers: { "WWW-Authenticate": 'Bearer realm="graffiticode"' },
});

export async function callerFor(c: Context): Promise<Caller> {
  const authorization = c.req.header("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim();
  const workspace = c.req.header("x-graffiticode-workspace")?.trim();
  const clientKind = c.req.header("user-agent")?.slice(0, 100);
  let ctx: Caller["ctx"];
  let forward: Record<string, string>;
  if (bearer) {
    ctx = { token: bearer, clientKind };
    forward = { Authorization: bearer };
  } else if (workspace) {
    let admitted: Awaited<ReturnType<typeof admitRequest>>;
    try {
      admitted = await admitRequest({ headers: { "x-free-plan-session": workspace } });
    } catch (err: any) {
      // A rate limit keeps its 429; any other refusal (bad signature, expired,
      // malformed) means the token isn't one we issued.
      if (err?.status === 429) {
        throw new ApiProblem(429, err.payload?.error ?? "rate_limited", "Too many requests", {
          detail: err.payload?.message, headers: { "Retry-After": String(err.payload?.retryAfter ?? 60) },
        });
      }
      throw new ApiProblem(401, "workspace_invalid", "Workspace token not valid", {
        detail: "This workspace token isn't valid or has expired. Start a new workspace with POST /workspaces.",
        headers: { "WWW-Authenticate": 'Bearer realm="graffiticode"' },
      });
    }
    if (!admitted.freePlan) throw challenge();
    ctx = { freePlan: true, sessionNamespace: admitted.sessionNamespace, sessionUuid: admitted.sessionUuid, clientKind };
    forward = { "X-Free-Plan-Session": workspace };
  } else {
    throw challenge();
  }
  let principal: Promise<Principal> | null = null;
  return {
    ctx,
    forward,
    principal: () => (principal ??= resolveAuth(ctx).catch((err) => {
      principal = null;
      if (bearer) throw challenge();
      throw fromCoreError(err);
    })),
  };
}

// A workspace token for the namespace core moved this caller to (a create that
// joined another item's workspace), or null when it didn't move.
export async function workspaceHandleIfMoved(caller: Caller, namespace: string | null | undefined) {
  if (!caller.ctx.freePlan || !namespace || namespace === caller.ctx.sessionNamespace) return null;
  return mintSessionToken({ sessionNamespace: namespace, sessionUuid: caller.ctx.sessionUuid || namespace });
}
