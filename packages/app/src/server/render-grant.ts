// Render grants (graffiticode repo, docs/c5-l0013-commands-plan.md; Policy's
// tokens.ts `render` profile). Under a command, L0013's camera has no user
// token: it renders a private item with a short-lived Policy grant for exactly
// one reserved capture of that item, pinned to the task chain its reservation
// resolved. This resolver accepts one only in its own render context:
//
//   GET /api/form/resolve?id=<itm>
//   Graffiticode-Render-Grant: <grant>
//
// - The grant never stands for its subject in general. It isn't read by
//   authFromRequest, and a request carrying both it and an Authorization
//   header, or anything but `id`, is refused.
// - It resolves only its own item (`itm`), held by its subject (`sub`), to
//   exactly the task its reservation pinned (`tsk`). An item that now names
//   another task is refused, never retargeted.
// - It answers only what the grant already names: no item record, owner or
//   view event. The task's ACLs are enforced where the task is read, by the
//   API's /form and /data under the same grant.
// - Answers are no-store, and the grant itself is never logged.

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

export const RENDER_GRANT_HEADER = "graffiticode-render-grant";
export const RENDER_TYP = "gc-render+jwt";
export const RENDER_AUDIENCE = "urn:graffiticode:render";
export const POLICY_ISSUER = "urn:graffiticode:policy";
export const MAX_LIFETIME_SECONDS = 5 * 60;
export const CLOCK_SKEW_SECONDS = 10;
export const DEFAULT_POLICY_JWKS_URL = "https://policy-sja7fatcta-uc.a.run.app/v1/jwks";

export type RenderGrant = {
  sub: string;
  itm: string;
  tsk: string;
  cmd: string;
  fg: number;
  stg: string;
  occ: string;
  cseq: number;
  jti: string;
  exp: number;
};

export class GrantRefused extends Error {
  constructor(readonly status: number, readonly reason: string) {
    super(reason);
  }
}

const STRING_CLAIMS = ["sub", "itm", "tsk", "cmd", "stg", "occ", "jti"] as const;
const NUMBER_CLAIMS = ["fg", "cseq", "iat", "exp"] as const;

// Verifies a grant exactly as Policy's `render` profile issues it: ES256, its
// own typ, issuer and audience, a lifetime of five minutes at most, and every
// claim present with its type. Anything else is GrantRefused(401).
export const verifyRenderGrant = async (
  token: string,
  { keys, now = () => Date.now() }: { keys: JWTVerifyGetKey; now?: () => number },
): Promise<RenderGrant> => {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      algorithms: ["ES256"],
      issuer: POLICY_ISSUER,
      audience: RENDER_AUDIENCE,
      typ: RENDER_TYP,
      clockTolerance: CLOCK_SKEW_SECONDS,
      currentDate: new Date(now()),
    }));
  } catch {
    throw new GrantRefused(401, "bad-render-grant");
  }
  const claims = payload as Record<string, unknown>;
  const typed = STRING_CLAIMS.every(c => typeof claims[c] === "string" && claims[c] !== "")
    && NUMBER_CLAIMS.every(c => typeof claims[c] === "number" && Number.isFinite(claims[c]));
  if (!typed) throw new GrantRefused(401, "bad-render-grant");
  const iat = claims.iat as number;
  const exp = claims.exp as number;
  if (exp - iat > MAX_LIFETIME_SECONDS || iat > now() / 1000 + CLOCK_SKEW_SECONDS) throw new GrantRefused(401, "bad-render-grant");
  const pick = Object.fromEntries([...STRING_CLAIMS, "fg", "cseq", "exp"].map(c => [c, claims[c]]));
  return pick as RenderGrant;
};

// Policy's public keys, fetched and cached by jose.
let remoteKeys: JWTVerifyGetKey | null = null;
export const policyKeys = (): JWTVerifyGetKey => {
  remoteKeys ??= createRemoteJWKSet(new URL(process.env.POLICY_JWKS_URL || DEFAULT_POLICY_JWKS_URL));
  return remoteKeys;
};

// The item as its subject holds it, read directly at users/{sub}/items/{itm}:
// the doc's own id and `id` field must agree, as item authority requires.
export type HeldItem = { exists: boolean; id?: unknown; taskId?: unknown };

// Decides a render-grant resolve. `params` are the request's query
// parameters; `authorization` is the request's Authorization header, if any.
// Returns the answer, or throws GrantRefused.
export const resolveWithGrant = async ({
  grantHeader,
  authorization,
  params,
  keys,
  readItem,
  now,
}: {
  grantHeader: string;
  authorization: string | null;
  params: URLSearchParams;
  keys: JWTVerifyGetKey;
  readItem: (uid: string, itemId: string) => Promise<HeldItem>;
  now?: () => number;
}): Promise<{ grant: RenderGrant; answer: { allowed: true; taskId: string; itemId: string } }> => {
  // One context per request: never a grant beside a user's credential.
  if (authorization) throw new GrantRefused(400, "mixed-credentials");
  const names = [...params.keys()];
  const id = params.get("id");
  if (names.length !== 1 || names[0] !== "id" || params.getAll("id").length !== 1 || !id) throw new GrantRefused(400, "bad-request");
  const grant = await verifyRenderGrant(grantHeader.trim(), { keys, now });
  if (id !== grant.itm) throw new GrantRefused(403, "grant-scope-mismatch");
  let item: HeldItem;
  try {
    item = await readItem(grant.sub, grant.itm);
  } catch {
    throw new GrantRefused(503, "item-store-unavailable");
  }
  if (!item.exists || item.id !== grant.itm) throw new GrantRefused(404, "item-not-found");
  if (item.taskId !== grant.tsk) throw new GrantRefused(409, "render-target-changed");
  return { grant, answer: { allowed: true, taskId: grant.tsk, itemId: grant.itm } };
};
