"use client";

import { WagmiProvider, createConfig } from "wagmi";
import { mainnet } from "viem/chains";
import { injected } from "wagmi/connectors";
import { http } from "viem";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PrivyProvider } from "@privy-io/react-auth";
import { GraffiticodeAuthProvider } from "./use-graffiticode-auth";
import { FirebaseProvider } from "./FirebaseProvider";
import { configureAuth } from "./auth-client";
import type { FirebaseWebConfig } from "./firebase-config";

const queryClient = new QueryClient();

const wagmiConfig = createConfig({
  chains: [mainnet],
  connectors: [injected()],
  transports: {
    [mainnet.id]: http(),
  },
});

const privyConfig = {
  loginMethods: ["email" as const],
  embeddedWallets: {
    createOnLogin: "off" as const,
  },
  appearance: {
    theme: "light" as const,
  },
};

// The installation's authentication settings, from its public configuration
// (/api/config). Required: the providers have no built-in settings to fall
// back to.
export type AuthConfig = { firebase: FirebaseWebConfig; privyAppId: string; authUrl: string };

export function AuthProviders({ children, config }: { children: React.ReactNode; config: AuthConfig }) {
  configureAuth({ authUrl: config.authUrl });
  return (
    <FirebaseProvider firebaseConfig={config.firebase}>
      <PrivyProvider appId={config.privyAppId} config={privyConfig}>
        <WagmiProvider config={wagmiConfig}>
          <QueryClientProvider client={queryClient}>
            <GraffiticodeAuthProvider>{children}</GraffiticodeAuthProvider>
          </QueryClientProvider>
        </WagmiProvider>
      </PrivyProvider>
    </FirebaseProvider>
  );
}
