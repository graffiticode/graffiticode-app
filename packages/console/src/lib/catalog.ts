// The language catalog in the browser, from the installation's public
// configuration (/api/config: catalog.languages). The browser never reads
// core's built-in catalog, which knows nothing of the installation's policy.
//
// Two lists, as in core (lib/languages.ts): the languages the installation
// OFFERS, which the picker lists and new items may use, and every language it
// RESOLVES, which includes those it no longer offers, so existing items (deep
// links, an item's own language) keep working. Use it through useCatalog().
import { useEffect, useMemo } from 'react';
import { useRouter } from 'next/router';
import type { PublicLanguage } from '@graffiticode-app/core/profile/public-config';
import { usePublicConfig } from './public-config';

export type Language = PublicLanguage;

export type Catalog = {
  // The offered languages, newest first (descending id), optionally only a
  // domain's.
  selectLanguages: (domain?: string) => Language[];
  // A language by its number ("0180" or "L0180"), offered or not: for an
  // existing item's language. Undefined only for a language the installation
  // doesn't resolve at all.
  findLanguageByNumber: (num: string) => Language | undefined;
};

export function catalogOf(languages: Language[]): Catalog {
  const offeredNewestFirst = languages.filter(l => l.offered).sort((a, b) => b.id.localeCompare(a.id));
  return {
    selectLanguages: (domain) => {
      if (!domain) return offeredNewestFirst;
      const d = domain.toLowerCase();
      return offeredNewestFirst.filter(l => l.domains.includes(d));
    },
    findLanguageByNumber: (num) => {
      const id = String(num).replace(/^L/i, '').padStart(4, '0');
      return languages.find(l => l.id === id);
    },
  };
}

export function useCatalog(): Catalog {
  const config = usePublicConfig();
  return useMemo(() => catalogOf(config.catalog.languages), [config]);
}

const DOMAIN_KEY = 'graffiticode:domain';

// The domain filter for the language picker: only one explicitly chosen, with
// ?domain= (remembered for the session), and only when it selects at least one
// offered language. Otherwise none: the installation's whole offered catalog.
// Never derived from the hostname, which says nothing about a catalog.
export function catalogDomain(explicit: string | null | undefined, catalog: Catalog): string | undefined {
  const d = explicit?.trim().toLowerCase();
  if (!d) return undefined;
  return catalog.selectLanguages(d).length > 0 ? d : undefined;
}

export function useCatalogDomain(): string | undefined {
  const router = useRouter();
  const catalog = useCatalog();
  const q = router.query.domain;
  const fromQuery = Array.isArray(q) ? q[0] : q;
  useEffect(() => {
    if (!fromQuery) return;
    try { sessionStorage.setItem(DOMAIN_KEY, fromQuery); } catch { /* storage unavailable */ }
  }, [fromQuery]);
  let stored: string | null = null;
  if (!fromQuery && typeof window !== 'undefined') {
    try { stored = sessionStorage.getItem(DOMAIN_KEY); } catch { /* storage unavailable */ }
  }
  return catalogDomain(fromQuery ?? stored, catalog);
}
