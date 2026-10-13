"use client";

import { useCallback } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useAuth } from "reactfire";
import { signOut as firebaseSignOut } from "firebase/auth";
import { suppressSsoBootstrap } from "./sso-client";

// Full sign-out: clears the Privy session and Firebase, and does NOT redirect
// (the caller owns the post-sign-out UI). Sign-out is local — it suppresses this
// tab's auto-bootstrap but leaves the shared global-session cookie intact, so
// other surfaces stay signed in and freshly opened tabs can still SSO in.
export function useSignOut() {
  const { logout } = usePrivy();
  const auth = useAuth();
  return useCallback(async () => {
    try {
      await logout();
    } catch {
      // Privy may already be logged out; ignore.
    }
    suppressSsoBootstrap();
    await firebaseSignOut(auth);
  }, [logout, auth]);
}
