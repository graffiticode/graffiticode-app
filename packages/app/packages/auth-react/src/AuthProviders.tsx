"use client";

import { WagmiProvider, createConfig } from "wagmi";
import { mainnet } from "viem/chains";
import { injected } from "wagmi/connectors";
import { http } from "viem";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PrivyProvider } from "@privy-io/react-auth";
import { GraffiticodeAuthProvider } from "./use-graffiticode-auth";
import { FirebaseProvider } from "./FirebaseProvider";

const queryClient = new QueryClient();

const config = createConfig({
  chains: [mainnet],
  connectors: [injected()],
  transports: {
    [mainnet.id]: http(),
  },
});

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID || "";

const privyConfig = {
  loginMethods: ["email" as const],
  embeddedWallets: {
    createOnLogin: "off" as const,
  },
  appearance: {
    theme: "light" as const,
  },
};

export function AuthProviders({ children }: { children: React.ReactNode }) {
  return (
    <FirebaseProvider>
      <PrivyProvider appId={PRIVY_APP_ID} config={privyConfig}>
        <WagmiProvider config={config}>
          <QueryClientProvider client={queryClient}>
            <GraffiticodeAuthProvider>{children}</GraffiticodeAuthProvider>
          </QueryClientProvider>
        </WagmiProvider>
      </PrivyProvider>
    </FirebaseProvider>
  );
}
