import { useRouter } from "next/router";
import { WagmiProvider, createConfig } from 'wagmi'
import { mainnet } from 'viem/chains'
import { injected } from 'wagmi/connectors'
import { http } from 'viem'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PrivyProvider } from '@privy-io/react-auth'
import { GraffiticodeAuthProvider, configureAuth } from "@graffiticode/auth-react";
import { ConfigGate, usePublicConfig } from '../lib/public-config';
import { useCatalog, useCatalogDomain } from '../lib/catalog';
import { PageTitleProvider } from '../lib/document-metadata';
import "../styles/globals.css";
import "../styles/prosemirror.css";
import GraffiticodeFirebaseProvider from '../components/GraffiticodeFirebaseProvider';
import Layout from '../components/layout';
import { useState, useEffect, useRef } from "react";
import useLocalStorage from '../hooks/use-local-storage';
import { marks } from "../components/mark-selector";
import { clients, findClientById } from "../components/client-selector";
import { DEFAULT_SORT, DEFAULT_DATE_FILTER } from "../components/items-header-menu";
import AuthWrapper from '../components/AuthWrapper';

const queryClient = new QueryClient()

const config = createConfig({
  chains: [mainnet],
  connectors: [
    injected(),
  ],
  transports: {
    [mainnet.id]: http(),
  },
})

const privyConfig = {
  loginMethods: ['email' as const],
  embeddedWallets: {
    createOnLogin: 'off' as const,
  },
  appearance: {
    theme: 'light' as const,
  },
};

// Nothing below ConfigGate renders, so no provider or client initializes,
// until the installation's public configuration has loaded and validated.
export default function App(props) {
  return (
    <PageTitleProvider>
      <ConfigGate>
        <ConfiguredApp {...props} />
      </ConfigGate>
    </PageTitleProvider>
  );
}

function ConfiguredApp({
  Component,
  pageProps: { session, ...pageProps },
}) {
  const publicConfig = usePublicConfig();
  configureAuth({ authUrl: publicConfig.hosts.auth });
  const PRIVY_APP_ID = publicConfig.auth.privyAppId;
  const { selectLanguages, findLanguageByNumber } = useCatalog();
  const router = useRouter();
  const pathName = router.pathname.split('/').filter(Boolean)[0] || '';
  const languageInitialized = useRef(false);

  // An explicitly chosen domain (?domain=), else the installation's whole
  // offered catalog (lib/catalog.ts).
  const domain = useCatalogDomain();
  const domainLanguages = selectLanguages(domain);
  // The list is newest first; the default is its lowest id, so an offered
  // language. (The placeholder only for an installation that offers none.)
  const defaultLanguage = domainLanguages.length > 0 ? domainLanguages[domainLanguages.length - 1] : {id: "0000", name: "L0000"};

  const [language, setLanguage] = useLocalStorage("graffiticode:language", defaultLanguage);
  const [mark, setMark] = useLocalStorage("graffiticode:items:mark", marks[0]);
  const [client, setClient] = useLocalStorage("graffiticode:items:client", clients[0]);
  const [sort, setSort] = useLocalStorage("graffiticode:items:sort", DEFAULT_SORT);
  const [dateFilter, setDateFilter] = useLocalStorage("graffiticode:items:dateFilter", DEFAULT_DATE_FILTER);

  // Set language/mark from query params or domain defaults on initial load
  useEffect(() => {
    if (!router.isReady) return;
    if (languageInitialized.current) return;

    // Apply ?lang= query param (e.g. ?lang=0166)
    const queryLang = router.query.lang;
    const langStr = Array.isArray(queryLang) ? queryLang[0] : queryLang;
    if (langStr) {
      const found = findLanguageByNumber(langStr);
      if (found) {
        setLanguage(found);
      }
    } else if (domainLanguages.length > 0) {
      const currentInDomain = domainLanguages.some(l => l.name === language.name);
      if (!currentInDomain) {
        setLanguage(defaultLanguage);
      }
    }

    // Apply ?mark= query param (e.g. ?mark=1)
    const queryMark = router.query.mark;
    const markStr = Array.isArray(queryMark) ? queryMark[0] : queryMark;
    if (markStr) {
      const markId = parseInt(markStr, 10);
      const found = marks.find(m => m.id === markId);
      if (found) {
        setMark(found);
      }
    }

    // Apply ?client= query param (e.g. ?client=mcp)
    const queryClientParam = router.query.client;
    const clientStr = Array.isArray(queryClientParam) ? queryClientParam[0] : queryClientParam;
    if (clientStr) {
      const found = findClientById(clientStr);
      if (found) {
        setClient(found);
      }
    }

    languageInitialized.current = true;
  }, [router.isReady, domainLanguages, language.name, setLanguage, setMark, setClient]);

  return (
    (pathName === "form" || pathName === "editor") &&
    <div id="gc-root">
      <GraffiticodeFirebaseProvider>
        <PrivyProvider appId={PRIVY_APP_ID} config={privyConfig}>
          <WagmiProvider config={config}>
            <QueryClientProvider client={queryClient}>
              <GraffiticodeAuthProvider>
                <Component {...{...pageProps, language, setLanguage, mark, setMark, client, setClient, sort, setSort, dateFilter, setDateFilter}} />
              </GraffiticodeAuthProvider>
            </QueryClientProvider>
          </WagmiProvider>
        </PrivyProvider>
      </GraffiticodeFirebaseProvider>
    </div> ||
    <div id="gc-root">
      <GraffiticodeFirebaseProvider>
        <PrivyProvider appId={PRIVY_APP_ID} config={privyConfig}>
          <WagmiProvider config={config}>
            <QueryClientProvider client={queryClient}>
              <GraffiticodeAuthProvider>
                <Layout
                  language={language}
                  setLanguage={setLanguage}
                  mark={mark}
                  setMark={setMark}
                >
                  <AuthWrapper>
                    <Component {...{...pageProps, language, setLanguage, mark, setMark, client, setClient, sort, setSort, dateFilter, setDateFilter}} />
                  </AuthWrapper>
                </Layout>
              </GraffiticodeAuthProvider>
            </QueryClientProvider>
          </WagmiProvider>
        </PrivyProvider>
      </GraffiticodeFirebaseProvider>
    </div>
  );
}
