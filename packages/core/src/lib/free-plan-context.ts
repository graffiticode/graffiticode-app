import { installedProfile } from "../profile/current.js";
import { displayUrl, installationBrand, signupUrlWith } from "../profile/brand.js";
import crypto from "crypto";
import { getCredentialsForApiKey, type ApiKeyCredentials } from "./api-credentials.js";
import { looksLikeSessionToken, verifySessionToken } from "./free-plan-session-token.js";

export const FREE_PLAN_SESSION_HEADER = "x-free-plan-session";

// How long an unclaimed free-plan item is kept: the profile's
// freePlan.itemTtlHours, or 48 hours. Read at use time, never captured.
const DEFAULT_FREE_PLAN_ITEM_TTL_HOURS = 48;
export function freePlanItemTtlMs(): number {
  const hours = installedProfile()?.profile.freePlan?.itemTtlHours ?? DEFAULT_FREE_PLAN_ITEM_TTL_HOURS;
  return hours * 60 * 60 * 1000;
}
export const freePlanItemTtlHours = () => Math.round(freePlanItemTtlMs() / 3_600_000);

// Whether anonymous use is allowed. Without a profile, as today: yes. A
// profile must say so (freePlan.enabled): a free plan is anonymous access, so
// an installation that doesn't mention one doesn't have one.
export function freePlanEnabled(): boolean {
  const installed = installedProfile();
  return installed ? installed.profile.freePlan?.enabled === true : true;
}

// The refusal for a free-plan request when the installation has no free plan.
export function buildFreePlanDisabledError(): FreePlanError {
  const b = installationBrand();
  return new FreePlanError("free_plan_disabled", 403, {
    error: "free_plan_disabled",
    message: `${b.name} requires an account. Sign in, or create a free account at ${displayUrl(b.signupUrl)}.`,
    signup_url: buildSignupUrl("free_plan_disabled"),
  });
}

export type FreePlanContext = {
  freePlan: true;
  sessionUuid: string;
  sessionNamespace: string;
};

export function deriveSessionNamespace(uuid: string): string {
  const salt = process.env.FREE_PLAN_NAMESPACE_SALT;
  // Never fall back to an unsalted hash. A missing salt used to yield a
  // globally-predictable namespace — anyone could compute it and read the
  // items inside — while looking like it worked. Fail like getFreePlanApiKey().
  if (!salt) {
    throw new Error("FREE_PLAN_NAMESPACE_SALT is not configured");
  }
  return crypto.createHash("sha256").update(`${salt}:${uuid}`).digest("hex");
}

function readHeader(req, name: string): string | undefined {
  const value = req.headers?.[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Resolve the free-plan session from the request header.
 *
 * Two accepted forms:
 * - A signed session/workspace token we issued. Its namespace is authoritative,
 *   which is what lets a client rejoin a workspace across the transport sessions
 *   it keeps losing.
 * - A raw session uuid, hashed on arrival. Self-asserted and therefore
 *   forgeable; accepted for compatibility until FREE_PLAN_REQUIRE_SIGNED_SESSION
 *   is set, at which point only the signed form gets in.
 *
 * A malformed or expired signed token is rejected outright rather than falling
 * back to hashing it as a uuid — that fallback would let anyone downgrade to the
 * forgeable path just by corrupting a byte.
 */
export async function isFreePlanRequest(
  req,
): Promise<FreePlanContext | { freePlan: false }> {
  const raw = readHeader(req, FREE_PLAN_SESSION_HEADER);
  if (!raw) return { freePlan: false };

  if (looksLikeSessionToken(raw)) {
    const { sessionNamespace, sessionUuid } = await verifySessionToken(raw);
    return { freePlan: true, sessionUuid, sessionNamespace };
  }

  if (process.env.FREE_PLAN_REQUIRE_SIGNED_SESSION === "true") {
    throw buildSessionInvalidError();
  }

  return {
    freePlan: true,
    sessionUuid: raw,
    sessionNamespace: deriveSessionNamespace(raw),
  };
}

export function getFreePlanApiKey(): string {
  const key = process.env.FREE_PLAN_API_KEY;
  if (!key) {
    throw new Error("FREE_PLAN_API_KEY is not configured");
  }
  return key;
}

// Resolves the free-plan account credentials by exchanging FREE_PLAN_API_KEY
// for a Firebase ID token. Caching/dedup is handled in api-credentials.
export function getFreePlanCredentials(): Promise<ApiKeyCredentials> {
  return getCredentialsForApiKey(getFreePlanApiKey());
}

export class FreePlanError extends Error {
  readonly code: string;
  readonly status: number;
  readonly payload: Record<string, unknown>;
  readonly extensions: Record<string, unknown>;

  constructor(code: string, status: number, payload: Record<string, unknown>) {
    super(typeof payload.message === "string" ? payload.message : code);
    this.code = code;
    this.status = status;
    this.payload = payload;
    this.extensions = { code, status, ...payload };
  }
}

// A free-plan session that isn't signed (once signed sessions are required).
export function buildSessionInvalidError(): FreePlanError {
  const b = installationBrand();
  return new FreePlanError("free_plan_session_invalid", 401, {
    error: "free_plan_session_invalid",
    message:
      `This free-plan session is not recognized. Reconnect to the ${b.name} MCP server ` +
      `to start a new session, or create a free account at ${displayUrl(b.signupUrl)}.`,
    signup_url: buildSignupUrl("invalid_session"),
  });
}

export function buildSignupUrl(medium: string, brand?: string): string {
  return signupUrlWith({ utm_source: "free_plan", utm_medium: medium, ...(brand ? { utm_campaign: brand } : {}) });
}
