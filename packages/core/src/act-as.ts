// Acting as a user who isn't present (app tier Phase 3.5). A generation job, or
// an effect that follows one, runs long after the request that started it, so
// the job never stores the user's token. Instead the producer signs a job-bound
// grant when it reserves the work, and the worker exchanges it at the auth
// service's POST /internal/act-as for a 5-minute token for that user. The
// exchange also needs the worker's own Cloud Run identity (a Google ID token
// with audience urn:graffiticode:auth); only console-run@ is allowed.
//
// The grant format is @graffiticode/common/act-as in the backend repo; it is
// reimplemented here (the app tier doesn't depend on backend packages) and
// pinned to it by a shared test vector (tests/baseline/act-as.test.ts).
import { createHmac } from "crypto";
import { coreConfig } from "./config.js";

export type ActAsPurpose = "generation" | "effect";

export type ActAsGrant = { purpose: ActAsPurpose; uid: string; subject: string; notAfter: number };

const MIN_SECRET_LENGTH = 32;

export function signActAsGrant(secret: string, grant: ActAsGrant): string {
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`ACT_AS_GRANT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  if (!grant.uid || !grant.subject || !Number.isFinite(grant.notAfter)) {
    throw new Error("act-as grant needs a uid, subject and notAfter");
  }
  const payload = Buffer.from(JSON.stringify({
    p: grant.purpose, u: grant.uid, s: grant.subject, n: grant.notAfter,
  })).toString("base64url");
  const mac = createHmac("sha256", secret).update(`act-as.v1.${payload}`).digest("base64url");
  return `${payload}.${mac}`;
}

// Signs with the configured secret. Throws when it isn't set, so a producer
// fails before reserving work its worker could never run.
export function signGrant(grant: ActAsGrant): string {
  return signActAsGrant(coreConfig().actAs.grantSecret, grant);
}

// The caller's Google ID token. On Cloud Run it comes from the metadata
// server; tests and local runs install their own.
type IdentityTokenProvider = (audience: string) => Promise<string>;

const METADATA_IDENTITY_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

const metadataIdentityToken: IdentityTokenProvider = async (audience) => {
  // format=full puts the service account's email in the token, which is what
  // the auth service checks against its caller list.
  const url = `${METADATA_IDENTITY_URL}?audience=${encodeURIComponent(audience)}&format=full`;
  const res = await fetch(url, { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new ActAsError(503, `metadata identity token: ${res.status}`);
  return res.text();
};

let identityTokenProvider: IdentityTokenProvider = metadataIdentityToken;

export function setIdentityTokenProvider(provider: IdentityTokenProvider | null) {
  identityTokenProvider = provider ?? metadataIdentityToken;
}

// `status` is the auth service's: 4xx means this grant will never be honoured
// (a definite refusal); anything else is worth trying again later.
export class ActAsError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ActAsError";
    this.status = status;
  }
  get definite() {
    return this.status >= 400 && this.status < 500;
  }
}

export async function actAsToken(request: { purpose: ActAsPurpose; uid: string; subject: string; grant: string }): Promise<string> {
  const { authUrl, actAs } = coreConfig();
  let identity: string;
  try {
    identity = await identityTokenProvider(actAs.audience);
  } catch (err) {
    if (err instanceof ActAsError) throw err;
    throw new ActAsError(503, `caller identity: ${(err as Error)?.message ?? err}`);
  }
  let res: Response;
  try {
    res = await fetch(`${authUrl}/internal/act-as`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Caller-Identity": identity },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new ActAsError(503, `act-as: ${(err as Error)?.message ?? err}`);
  }
  const body: any = await res.json().catch(() => null);
  if (!res.ok) throw new ActAsError(res.status, `act-as refused: ${body?.error?.message ?? res.status}`);
  const token = body?.data?.accessToken;
  if (typeof token !== "string" || !token) throw new ActAsError(502, "act-as: no token in response");
  return token;
}
