// Server-side client for the policy authority (delegated API permissions).
//
// The console manages a user's connections through policy. There are no
// intents: running a program is the action, and the grant is the authority.
// Policy is a private
// Cloud Run service in project graffiticode; the console calls it with its own
// service account's ID tokens (Cloud Run IAM + X-Caller-Identity) and the
// user's Firebase ID token in Authorization, which policy re-verifies.
//
// Unset POLICY_URL disables connections: every call reports "unavailable"
// rather than falling back to anything.
import { GoogleAuth } from "google-auth-library";

const POLICY_AUDIENCE = "urn:graffiticode:policy";

export class PolicyError extends Error {
  status: number;
  reason?: string;
  constructor(message: string, status: number, reason?: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

export type Connection = {
  connectionId: string;
  backend: string;
  status: "active" | "disabled";
  label: string | null;
  // A configured Graffiticode system connection (policy marks it): it signs
  // system previews only and policy refuses it for writes, so it is never
  // offered as a connection to save through. False when policy predates the
  // flag.
  system: boolean;
  // For the owner's own connections: the (lang, fn) pairs the owner allows
  // themselves through it, or null for everything (absent from a policy that
  // predates it, which means the same).
  ownerPermissions?: Permission[] | null;
};

// The flag is read strictly: only an explicit true marks a system connection.
const withSystemFlag = <T extends { system?: unknown }>(c: T): T & { system: boolean } =>
  ({ ...c, system: c.system === true });

// A connection someone else owns and has shared with this user.
// ownerUid: who shared it (absent from a policy that predates it).
export type SharedConnection = Connection & { permissions: Permission[]; expiresAt: string | null; ownerUid?: string };

// One function in one language, e.g. { lang: "0176", fn: "save-to-itembank" }.
export type Permission = { lang: string; fn: string };
export type ShareableFunction = Permission & { kind: string };
// Every protected function on a connection's backend: the owner's own list may
// name any of them, a grant only the delegable ones.
export type ConnectionFunction = ShareableFunction & { implicit: boolean; delegable: boolean };

export type ConnectionGrant = {
  grantId: string;
  recipientLabel: string | null;
  pending: boolean;
  permissions: Permission[];
  expiresAt: string | null;
  createdAt: string;
};

// What a grant sets: the exact functions it allows, and an optional end.
export type GrantAccess = { permissions: Permission[]; expiresAt?: string | null };

let auth: GoogleAuth | null = null;
const idTokenClients = new Map<string, Promise<any>>();

async function idToken(audience: string): Promise<string> {
  auth ??= new GoogleAuth();
  if (!idTokenClients.has(audience)) {
    idTokenClients.set(audience, auth.getIdTokenClient(audience));
  }
  const client = await idTokenClients.get(audience);
  const headers = await client.getRequestHeaders();
  const value = headers.Authorization ?? headers.authorization;
  if (typeof value !== "string") {
    throw new PolicyError("no service identity token", 503);
  }
  return value.replace(/^Bearer\s+/, "");
}

export function policyEnabled(): boolean {
  return Boolean(process.env.POLICY_URL);
}

async function call(method: string, path: string, userToken: string, body?: unknown) {
  const policyUrl = process.env.POLICY_URL;
  if (!policyUrl) {
    throw new PolicyError("connections are unavailable", 503, "unavailable");
  }
  const [invoker, caller] = await Promise.all([idToken(policyUrl), idToken(POLICY_AUDIENCE)]);
  const res = await fetch(`${policyUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Serverless-Authorization": `Bearer ${invoker}`,
      "X-Caller-Identity": caller,
      Authorization: `Bearer ${userToken}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    // fall through with a null body
  }
  if (!res.ok || json?.status !== "success") {
    // Only the reason travels back; policy never returns secrets or tokens in
    // an error, and this never logs a request body.
    throw new PolicyError(`policy ${path} failed (${res.status})`, res.status, json?.error?.reason);
  }
  return json.data;
}

export const listConnections = async (userToken: string): Promise<Connection[]> =>
  ((await call("GET", "/v1/connections", userToken)) as Connection[]).map(withSystemFlag);

export const createConnection = (
  userToken: string,
  { backend, label, key, secret }: { backend: string; label?: string | null; key: string; secret: string },
): Promise<Connection> =>
  call("POST", "/v1/connections", userToken, { backend, label: label ?? null, credential: { key, secret } }).then(withSystemFlag);

export const rotateConnection = (userToken: string, connectionId: string, { key, secret }: { key: string; secret: string }) =>
  call("POST", `/v1/connections/${encodeURIComponent(connectionId)}/rotate`, userToken, { credential: { key, secret } });

export const disableConnection = (userToken: string, connectionId: string) =>
  call("POST", `/v1/connections/${encodeURIComponent(connectionId)}/disable`, userToken, {});

export const deleteConnection = (userToken: string, connectionId: string) =>
  call("DELETE", `/v1/connections/${encodeURIComponent(connectionId)}`, userToken);

// Sharing (delegation). The owner grants access (GrantAccess) to an account,
// or to a hash of an email until that person signs in with it.
export const shareConnection = (
  userToken: string,
  connectionId: string,
  grant: { recipientUid?: string | null; recipientEmailHash?: string | null; recipientLabel?: string | null } & GrantAccess,
): Promise<ConnectionGrant> =>
  call("POST", `/v1/connections/${encodeURIComponent(connectionId)}/grants`, userToken, grant);

// Changes an existing grant's access or end date; its recipient stays.
export const updateConnectionGrant = (userToken: string, connectionId: string, grantId: string, access: GrantAccess): Promise<ConnectionGrant> =>
  call("PATCH", `/v1/connections/${encodeURIComponent(connectionId)}/grants/${encodeURIComponent(grantId)}`, userToken, access);

export const listShareableFunctions = (userToken: string, connectionId: string): Promise<ShareableFunction[]> =>
  call("GET", `/v1/connections/${encodeURIComponent(connectionId)}/shareable`, userToken);

export const listConnectionFunctions = (userToken: string, connectionId: string): Promise<ConnectionFunction[]> =>
  call("GET", `/v1/connections/${encodeURIComponent(connectionId)}/functions`, userToken);

// The owner limits their own use of the connection; null restores everything.
export const setOwnerPermissions = (userToken: string, connectionId: string, permissions: Permission[] | null) =>
  call("PUT", `/v1/connections/${encodeURIComponent(connectionId)}/owner-permissions`, userToken, { permissions });

export const listConnectionGrants = (userToken: string, connectionId: string): Promise<ConnectionGrant[]> =>
  call("GET", `/v1/connections/${encodeURIComponent(connectionId)}/grants`, userToken);

export const revokeConnectionGrant = (userToken: string, connectionId: string, grantId: string) =>
  call("DELETE", `/v1/connections/${encodeURIComponent(connectionId)}/grants/${encodeURIComponent(grantId)}`, userToken);

export const listSharedConnections = async (userToken: string): Promise<SharedConnection[]> =>
  ((await call("GET", "/v1/shared", userToken)) as SharedConnection[]).map(withSystemFlag);

export const leaveSharedConnection = (userToken: string, connectionId: string) =>
  call("DELETE", `/v1/shared/${encodeURIComponent(connectionId)}`, userToken);

export const claimConnectionGrants = (userToken: string, emailHashes: string[]): Promise<{ claimed: number }> =>
  call("POST", "/v1/grants/claim", userToken, { emailHashes });
