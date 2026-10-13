"use client";

// Client-side SSO helpers. These talk to the hosting app's own /api/sso/*
// routes (relative URLs), which set/read the HttpOnly refresh-token cookie that
// is shared across *.graffiticode.org. All are best-effort: SSO must never
// block or break a normal sign-in/out, so failures are logged and swallowed.
//
// Model: the shared cookie is a *persistent global session* — a sign-in sets it
// and any surface bootstraps a local session from it. Sign-out is local and does
// NOT clear the cookie; instead it suppresses auto-bootstrap for the current tab
// (sessionStorage, per-tab) so that tab stays signed out, while other surfaces
// and freshly opened tabs still bootstrap from the global session.

const SUPPRESS_KEY = "graffiticode:sso:suppress";

// Stores the refresh token in the shared SSO cookie after a successful sign-in.
export async function setSsoSession(refreshToken: string | undefined | null): Promise<void> {
  if (!refreshToken) return;
  try {
    await fetch("/api/sso/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
  } catch (err) {
    console.error("[sso] setSsoSession failed", err);
  }
}

// Asks the hosting app to exchange the shared SSO cookie for a Firebase custom
// token. Returns the token (to pass to signInWithCustomToken) or null when
// there's no usable session.
export async function bootstrapSsoSession(): Promise<string | null> {
  try {
    const res = await fetch("/api/sso/bootstrap", { method: "GET" });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    const token = body?.firebaseCustomToken;
    return typeof token === "string" && token ? token : null;
  } catch (err) {
    console.error("[sso] bootstrapSsoSession failed", err);
    return null;
  }
}

// Marks the current tab as having explicitly signed out, so it doesn't
// auto-bootstrap back in from the still-present global-session cookie. Per-tab
// (sessionStorage) so other tabs/surfaces are unaffected.
export function suppressSsoBootstrap(): void {
  try {
    if (typeof window !== "undefined") sessionStorage.setItem(SUPPRESS_KEY, "1");
  } catch {
    // sessionStorage unavailable — non-fatal.
  }
}

export function clearSsoSuppress(): void {
  try {
    if (typeof window !== "undefined") sessionStorage.removeItem(SUPPRESS_KEY);
  } catch {
    // ignore
  }
}

export function isSsoBootstrapSuppressed(): boolean {
  try {
    return typeof window !== "undefined" && sessionStorage.getItem(SUPPRESS_KEY) === "1";
  } catch {
    return false;
  }
}
