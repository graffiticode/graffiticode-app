"use client";

import { useEffect, useState } from "react";
import { AuthProviders } from "@graffiticode/auth-react";

// Auth (Firebase/Privy/Wagmi) is inherently client-side, and PrivyProvider
// validates its app id eagerly at render. Mounting the provider chain only on
// the client keeps it out of SSR/prerender (so builds don't need secrets) and
// avoids initializing browser-only SDKs on the server.
export function Providers({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-gray-900" />
      </div>
    );
  }

  return <AuthProviders>{children}</AuthProviders>;
}
