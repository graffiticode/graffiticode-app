"use client";

import { AuthProviders } from "@graffiticode/auth-react";
import { ConfigGate, usePublicConfig } from "@/lib/public-config";
import { DocumentMetadata } from "@/lib/document-metadata";

// Auth (Firebase/Privy/Wagmi) is inherently client-side. ConfigGate renders
// nothing until the installation's public configuration has loaded and
// validated (on the client, so builds and prerender need no installation),
// and the providers then initialize with that installation's settings only.
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ConfigGate>
      <ConfiguredProviders>{children}</ConfiguredProviders>
    </ConfigGate>
  );
}

function ConfiguredProviders({ children }: { children: React.ReactNode }) {
  const config = usePublicConfig();
  return (
    <AuthProviders config={{ firebase: config.auth.firebase, privyAppId: config.auth.privyAppId, authUrl: config.hosts.auth }}>
      <DocumentMetadata />
      {children}
    </AuthProviders>
  );
}
