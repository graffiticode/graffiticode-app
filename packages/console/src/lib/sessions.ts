// Sessions: the places this account is signed in. Each is an auth-service refresh token
// (30 days), started by a wallet, email or Google sign-in. The browser's own session is the
// one in the HttpOnly `gc_sso` cookie, which only the console server can read, so the page
// talks to auth through /api/sessions (helpers below), and the server attaches the cookie.

const authUrl = () => (process.env.NEXT_PUBLIC_GC_AUTH_URL || "https://auth.graffiticode.org").replace(/\/$/, "");

export type SessionMethod = "wallet" | "email" | "google";

export interface Session {
  id: string;
  createdAt: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  method: SessionMethod | null;
  userAgent: string | null;
  current: boolean;
}

// "Chrome on macOS", from a user agent. Order matters: Edge and Opera also say Chrome, and
// Chrome also says Safari.
const BROWSERS: [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Version\/[\d.]+.*Safari\//, "Safari"],
];
const SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPad|iPod/, "iOS"],
  [/Android/, "Android"],
  [/CrOS/, "ChromeOS"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Windows/, "Windows"],
  [/Linux/, "Linux"],
];
const first = (ua: string, table: [RegExp, string][]) => table.find(([re]) => re.test(ua))?.[1] ?? null;

export function describeUserAgent(ua: string | null | undefined): string {
  if (!ua) return "Unknown device";
  const browser = first(ua, BROWSERS);
  const system = first(ua, SYSTEMS);
  if (browser && system) return `${browser} on ${system}`;
  return browser || system || "Unknown device";
}

export function methodLabel(method: SessionMethod | null): string {
  if (method === "wallet") return "Wallet";
  if (method === "email") return "Email";
  if (method === "google") return "Google";
  return "Sign-in";
}

const errorMessage = async (res: Response, fallback: string) => {
  const body = await res.json().catch(() => ({}));
  return body?.error?.message || fallback;
};

// --- Browser: the page's calls to the console's /api/sessions ---

export async function listSessions(token: string): Promise<Session[]> {
  const res = await fetch("/api/sessions", { headers: { Authorization: token } });
  if (!res.ok) throw new Error(await errorMessage(res, "Failed to list sessions"));
  const body = await res.json();
  return body.data || [];
}

export async function endSession(token: string, id: string): Promise<void> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE", headers: { Authorization: token } });
  if (!res.ok) throw new Error(await errorMessage(res, "Failed to sign out the session"));
}

export async function endOtherSessions(token: string): Promise<void> {
  const res = await fetch("/api/sessions", { method: "DELETE", headers: { Authorization: token } });
  if (!res.ok) throw new Error(await errorMessage(res, "Failed to sign out other sessions"));
}

// --- Server: the console's calls to auth. `authorization` is the caller's own token, passed
// through; `refreshToken` is the cookie's. The refresh token travels in a header or a body,
// never a URL. Each returns auth's response for the route to relay. ---

export function authListSessions({ authorization, refreshToken }: { authorization: string; refreshToken: string | null }) {
  return fetch(`${authUrl()}/v1/refresh-tokens/sessions`, {
    headers: { Authorization: authorization, ...(refreshToken ? { "X-Refresh-Token": refreshToken } : {}) },
  });
}

export function authEndSession({ authorization, id }: { authorization: string; id: string }) {
  return fetch(`${authUrl()}/v1/refresh-tokens/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: authorization },
  });
}

// Ends every session but the cookie's. Without a cookie that would end them all, the
// caller's included, so it is refused.
export function authEndOtherSessions({ authorization, refreshToken }: { authorization: string; refreshToken: string }) {
  return fetch(`${authUrl()}/v1/refresh-tokens/sessions`, {
    method: "DELETE",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
}

// Sign-out: end the cookie's session at auth, so the token stops working everywhere, not
// just in this browser. Best effort: a slow or failed revoke never blocks signing out.
export async function revokeSession(refreshToken: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetch(`${authUrl()}/v1/refresh-tokens/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch (err) {
    console.error("[sso] revoke failed", err);
    return false;
  }
}
