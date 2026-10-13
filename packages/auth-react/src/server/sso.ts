// Shared server-side SSO helpers. Used by each consuming app's /api/sso/*
// route handlers so console.graffiticode.org and app.graffiticode.org can share
// a single sign-in via a refresh-token cookie scoped to the parent domain.
//
// The cookie holds the auth service's 30-day refresh token. A sibling app with
// no Firebase session reads the cookie and exchanges it for a fresh Firebase
// custom token via the auth service's existing /oauth/token endpoint — so no
// auth-service change is required.

export const SSO_COOKIE_NAME = "gc_sso";

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

const authUrl = () =>
  (process.env.NEXT_PUBLIC_GC_AUTH_URL || "https://auth.graffiticode.org").replace(/\/$/, "");

// Cookie Domain is env-gated: in prod set SSO_COOKIE_DOMAIN=.graffiticode.org so
// the cookie is shared across console/app subdomains. Locally it's unset, so the
// cookie defaults to the current host (localhost) — which is shared across ports
// since cookies are not port-scoped.
const cookieDomain = () => process.env.SSO_COOKIE_DOMAIN || "";

function buildCookie(value: string, maxAgeSeconds: number): string {
  const parts = [
    `${SSO_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  const domain = cookieDomain();
  if (domain) parts.push(`Domain=${domain}`);
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

// Returns the Set-Cookie header value that stores the refresh token.
export function buildSetSsoCookie(refreshToken: string): string {
  return buildCookie(encodeURIComponent(refreshToken), THIRTY_DAYS_SECONDS);
}

// Returns the Set-Cookie header value that clears the SSO cookie.
export function buildClearSsoCookie(): string {
  return buildCookie("", 0);
}

// Parses the refresh token out of a request's Cookie header, or null.
export function readSsoCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === SSO_COOKIE_NAME) {
      const raw = part.slice(eq + 1).trim();
      if (!raw) return null;
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

// Exchanges a refresh token for a fresh Firebase custom token via the auth
// service's OAuth refresh grant. Returns null on any failure (expired/revoked
// token, network error) so callers can fall back to a normal sign-in.
export async function bootstrapFirebaseToken(refreshToken: string): Promise<string | null> {
  try {
    const res = await fetch(`${authUrl()}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const token = body?.data?.firebaseCustomToken ?? body?.firebaseCustomToken;
    return typeof token === "string" && token ? token : null;
  } catch (err) {
    console.error("[sso] bootstrapFirebaseToken failed", err);
    return null;
  }
}
