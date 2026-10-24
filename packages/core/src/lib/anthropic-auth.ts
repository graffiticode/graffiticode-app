/**
 * Credentials for calling the Claude API: Workload Identity Federation first, the static key as a fallback.
 *
 * Federation (2026-10-24, replacing the exposed static ANTHROPIC_API_KEY): the Cloud Run service account asks the
 * metadata server for a Google-signed identity token (audience https://api.anthropic.com, format=full), exchanges it
 * at POST /v1/oauth/token for a short-lived access token bound to an Anthropic service account, and sends that as
 * `Authorization: Bearer`. Nothing static is stored. See
 * https://platform.claude.com/docs/en/manage-claude/wif-providers/gcp.
 *
 * Configured by ANTHROPIC_FEDERATION_RULE_ID, ANTHROPIC_ORGANIZATION_ID and ANTHROPIC_SERVICE_ACCOUNT_ID (all
 * required; ANTHROPIC_WORKSPACE_ID optional). None of these is a secret.
 *
 * Migration: while ANTHROPIC_API_KEY is still set, a failed exchange falls back to it and logs loudly, so turning
 * federation on can't take generation down. Once federation is verified the key is removed from the service, and
 * after that a failed exchange is an error. Every caller goes through here; none reads ANTHROPIC_API_KEY itself.
 */

const ANTHROPIC_BASE = "https://api.anthropic.com";
const METADATA_IDENTITY_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity" +
  "?audience=https%3A%2F%2Fapi.anthropic.com&format=full";
/** Refresh this long before the access token expires (the SDKs' advisory window). */
const REFRESH_MARGIN_MS = 120_000;

type Fetch = typeof fetch;
const defaultFetch: Fetch = (input, init) => fetch(input, init);
let fetchImpl: Fetch = defaultFetch;
let now = () => Date.now();

/** Test seam: replace the HTTP client and the clock. Never used in production. */
export function __setAnthropicAuthTestHooks(hooks: { fetch?: Fetch; now?: () => number } | null): void {
  fetchImpl = hooks?.fetch ?? defaultFetch;
  now = hooks?.now ?? (() => Date.now());
  cached = null;
  inflight = null;
}

interface FederationConfig {
  federationRuleId: string;
  organizationId: string;
  serviceAccountId: string;
  workspaceId?: string;
}

function federationConfig(): FederationConfig | null {
  const federationRuleId = process.env.ANTHROPIC_FEDERATION_RULE_ID;
  const organizationId = process.env.ANTHROPIC_ORGANIZATION_ID;
  const serviceAccountId = process.env.ANTHROPIC_SERVICE_ACCOUNT_ID;
  if (!federationRuleId || !organizationId || !serviceAccountId) return null;
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID || undefined;
  return { federationRuleId, organizationId, serviceAccountId, ...(workspaceId ? { workspaceId } : {}) };
}

/** Whether any Claude credential is configured: federation, or (until it is removed) the static key. */
export function anthropicCredentialsConfigured(): boolean {
  return federationConfig() !== null || Boolean(process.env.ANTHROPIC_API_KEY);
}

let cached: { token: string; expiresAt: number } | null = null;
let inflight: Promise<string> | null = null;

/**
 * A fresh Google identity token for every exchange: Anthropic treats tokens that carry a `jti` as single-use, and a
 * cached one would be refused on the next exchange.
 */
async function googleIdentityToken(): Promise<string> {
  const res = await fetchImpl(METADATA_IDENTITY_URL, { headers: { "Metadata-Flavor": "Google" } });
  if (!res.ok) throw new Error(`metadata identity token failed (${res.status})`);
  const token = (await res.text()).trim();
  if (!token) throw new Error("metadata identity token was empty");
  return token;
}

async function exchange(config: FederationConfig): Promise<string> {
  const assertion = await googleIdentityToken();
  const res = await fetchImpl(`${ANTHROPIC_BASE}/v1/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
      federation_rule_id: config.federationRuleId,
      organization_id: config.organizationId,
      service_account_id: config.serviceAccountId,
      ...(config.workspaceId ? { workspace_id: config.workspaceId } : {}),
    }),
  });
  // A denied exchange is an opaque 401; the reason is on the Claude Console's authentication history page.
  if (!res.ok) throw new Error(`Anthropic token exchange failed (${res.status})`);
  const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new Error("Anthropic token exchange returned no access_token");
  }
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 60;
  cached = { token: body.access_token, expiresAt: now() + expiresIn * 1000 };
  return body.access_token;
}

/** A federated access token, cached and refreshed before it expires; concurrent callers share one exchange. */
async function federatedAccessToken(config: FederationConfig): Promise<string> {
  if (cached && now() < cached.expiresAt - REFRESH_MARGIN_MS) return cached.token;
  if (!inflight) {
    inflight = exchange(config).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/**
 * The auth header for a Claude API request. Federation when configured; the static key when federation isn't
 * configured, or as a logged fallback when an exchange fails while the key is still set. Throws when neither works.
 */
export async function anthropicAuthHeaders(): Promise<Record<string, string>> {
  const config = federationConfig();
  const key = process.env.ANTHROPIC_API_KEY;
  if (config) {
    try {
      return { authorization: `Bearer ${await federatedAccessToken(config)}` };
    } catch (err) {
      if (!key) throw err;
      console.error(
        `[anthropic-auth] federation failed, falling back to ANTHROPIC_API_KEY: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (key) return { "x-api-key": key };
  throw new Error("Anthropic credentials not configured (no federation, no ANTHROPIC_API_KEY)");
}

/** Which credential the next request would use, for health checks and logs. Never returns secret material. */
export function anthropicAuthMode(): "federation" | "api-key" | "none" {
  if (federationConfig()) return "federation";
  return process.env.ANTHROPIC_API_KEY ? "api-key" : "none";
}
