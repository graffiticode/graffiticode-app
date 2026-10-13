import { useCallback } from "react";
import { useDisconnect } from "wagmi";
import useGraffiticodeAuth from "@graffiticode/auth-react";

// Global single sign-out.
//
// The package's signOut (`@graffiticode/auth-react`) is a *local* sign-out: it
// only suppresses THIS tab's SSO bootstrap (per-tab sessionStorage) and leaves
// the shared `.graffiticode.org` SSO cookie intact. A freshly opened tab has no
// suppress flag, so its bootstrap effect exchanges the still-valid cookie for a
// Firebase token and the user appears signed back in.
//
// Clearing the shared cookie (DELETE /api/sso/session) makes sign-out stick
// across tabs and sibling surfaces (single sign-out, per that route's intent).
// We also drop the wagmi wallet connection so the next sign-in starts clean.
export function useConsoleSignOut() {
  const { signOut } = useGraffiticodeAuth();
  const { disconnect } = useDisconnect();
  return useCallback(async () => {
    try {
      await fetch("/api/sso/session", { method: "DELETE" });
    } catch (err) {
      console.error("[sso] clear session failed", err);
    }
    try {
      disconnect();
    } catch {
      // wallet may already be disconnected — non-fatal
    }
    // Package sign-out: Firebase signOut + per-tab suppress + redirect to "/".
    await signOut();
  }, [signOut, disconnect]);
}
