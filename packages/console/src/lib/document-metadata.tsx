// The document's title and description (installations plan, P3, slice 3):
// one owner, DocumentMetadata, rendered by ConfigGate in every state. Before
// the installation's configuration has loaded (and so in the prerendered
// HTML, the same for every installation) it carries the build's defaults;
// after, the installation's (metadata.console), across client-side navigation.
//
// Pages don't set <title> or a description themselves: a page names what it is
// with <PageTitle suffix="Billing" />, and the owner composes "<title> -
// Billing". When the page goes, its suffix goes with it.
import Head from "next/head";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { PublicConfig } from "@graffiticode-app/core/profile/public-config";

// The build's defaults: the built-in installation's (core's
// BUILT_IN_CONSOLE_METADATA), and what the prerendered HTML carries.
const DEFAULTS = { title: "Console", description: "Graffiticode - A software studio" };

type Titles = { suffixes: { id: number; suffix: string }[]; push: (s: string) => number; drop: (id: number) => void };
const TitleContext = createContext<Titles | null>(null);

export function PageTitleProvider({ children }: { children: ReactNode }) {
  const [suffixes, setSuffixes] = useState<Titles["suffixes"]>([]);
  const [api] = useState(() => {
    let next = 1;
    return {
      push: (suffix: string) => { const id = next++; setSuffixes(s => [...s, { id, suffix }]); return id; },
      drop: (id: number) => setSuffixes(s => s.filter(x => x.id !== id)),
    };
  });
  return <TitleContext.Provider value={{ suffixes, ...api }}>{children}</TitleContext.Provider>;
}

// What the page is, for the title: the most recently mounted one wins.
export function PageTitle({ suffix }: { suffix?: string }) {
  const titles = useContext(TitleContext);
  useEffect(() => {
    if (!titles || !suffix) return;
    const id = titles.push(suffix);
    return () => titles.drop(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suffix]);
  return null;
}

export function DocumentMetadata({ config }: { config: PublicConfig | null }) {
  const titles = useContext(TitleContext);
  const own = config?.metadata.console ?? DEFAULTS;
  const suffix = titles?.suffixes.at(-1)?.suffix;
  return (
    <Head>
      <title key="title">{suffix ? `${own.title} - ${suffix}` : own.title}</title>
      <meta key="description" name="description" content={own.description} />
    </Head>
  );
}
