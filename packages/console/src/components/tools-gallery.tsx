import { useState, useCallback, useRef, useEffect } from 'react';
import { useRouter } from 'next/router';
import useSWR from 'swr';
import useGraffiticodeAuth from '@graffiticode/auth-react';
import { selectLanguages } from './language-selector';
import { countItems, loadItemNames, loadItems } from '../utils/swr/fetchers';
import ToolsThumbnailGrid from './tools-thumbnail-grid';
import SignIn from './SignIn';
import { getTitle } from '../lib/utils';

// The dialect that renders an item's form view to a PNG; its items are named after the
// source item id they snapped. Same constant as lib/generate-thumbnail.ts.
const SNAP_LANG = '0013';

// The mark an L0013 snap item must carry to appear in the gallery. Matches the corpus
// convention elsewhere in the repo, where 3 is the curated set rather than raw capture.
const APPROVED_MARK = 3;

function classNames(...classes) {
  return classes.filter(Boolean).join(' ')
}

export default function ToolsGallery({ language, setLanguage }) {
  const { user } = useGraffiticodeAuth();
  const router = useRouter();
  const queryDomain = router.query.domain;
  const queryDomainStr = Array.isArray(queryDomain) ? queryDomain[0] : queryDomain;
  const storedDomain = typeof window !== 'undefined' ? sessionStorage.getItem('graffiticode:domain') : null;
  const rawDomain = queryDomainStr || storedDomain || getTitle();
  const domain = rawDomain.toLowerCase() === 'graffiticode' ? undefined : rawDomain;
  const languages = selectLanguages(domain);

  const [selectedLang, setSelectedLang] = useState<string | null>(language?.name || null);

  const langItemRefs = useRef<Record<string, HTMLLIElement | null>>({});
  const langListRef = useRef<HTMLUListElement>(null);
  const [isLangPanelCollapsed, setIsLangPanelCollapsed] = useState(
    typeof window !== 'undefined' && localStorage.getItem('graffiticode:tools:langPanelCollapsed') === 'true'
  );

  // Auto-focus the list when languages are available
  useEffect(() => {
    if (languages.length > 0 && langListRef.current) {
      langListRef.current.focus();
    }
  }, [languages.length > 0]);

  const { data: itemCounts } = useSWR(
    user ? { user, langs: languages } : null,
    countItems,
    // Selecting a tool re-renders the tree and revalidates; keep the prior
    // counts on screen instead of flashing "0" while the refetch is in flight.
    { keepPreviousData: true, revalidateIfStale: false },
  );

  const selectedLanguage = selectedLang ? languages.find(l => l.name === selectedLang) : null;
  const selectedLangId = selectedLanguage?.id ?? null;
  const { data: langInfo } = useSWR(
    selectedLangId ? `https://l${selectedLangId}.graffiticode.org/language-info.json` : null,
    (url) => fetch(url).then(r => r.ok ? r.json() : null),
  );

  // The selected language's items (current user) — each renders as a thumbnail if an image exists.
  const { data: toolItems } = useSWR(
    user && selectedLangId ? { user, lang: selectedLangId, mark: null, client: 'all' } : null,
    loadItems,
  );

  // The gallery is curated, not "whatever PNG happens to exist". Every thumbnail is produced by
  // an L0013 `snap` item named after its source item id (see lib/generate-thumbnail.ts), and mark
  // 3 on that L0013 item is what admits the image here — anything else (a fresh snap lands at
  // mark 1) keeps the PNG but stays out of the gallery, so promoting to 3 is the publish step.
  // Loaded once for the user rather than per language, since one L0013 collection backs every
  // language's tiles. Only the snap items' names are needed, so only names are fetched.
  const { data: snapItems } = useSWR(
    user ? { user, lang: SNAP_LANG, mark: APPROVED_MARK, names: true } : null,
    loadItemNames,
  );
  const approvedIds = new Set(snapItems || []);

  const toggleLangPanel = useCallback(() => {
    const newState = !isLangPanelCollapsed;
    setIsLangPanelCollapsed(newState);
    if (typeof window !== 'undefined') {
      localStorage.setItem('graffiticode:tools:langPanelCollapsed', newState.toString());
    }
  }, [isLangPanelCollapsed]);

  const handleSelectLanguage = (lang) => {
    setSelectedLang(lang.name);
    // Make this the app-wide selected language so the Items page shows its items.
    setLanguage(lang);
  };

  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-100px)]">
        <SignIn label="Sign in to continue" />
        <p className="mt-4 text-sm text-gray-600 text-center max-w-sm">
          New here? Create a free account by signing in with an Ethereum wallet. No blockchain fees required.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-64px)] w-full">
      <div className="flex grow w-full overflow-hidden">
        {/* Languages panel */}
        <div className={classNames(
          "flex-none transition-all duration-300 border border-gray-200 rounded-none mr-1",
          isLangPanelCollapsed ? "w-10" : "w-[210px]",
          isLangPanelCollapsed ? "h-10" : "h-[calc(100vh-90px)]"
        )}>
          <div className="flex justify-between items-center p-2 border-b border-gray-200">
            <span className={classNames(
              "text-sm font-medium text-gray-700",
              isLangPanelCollapsed && "hidden"
            )}>Tools</span>
            <button
              className="text-gray-400 hover:text-gray-500 focus:outline-none"
              title={isLangPanelCollapsed ? "Expand tools panel" : "Collapse tools panel"}
              onClick={toggleLangPanel}>
              {isLangPanelCollapsed ? (
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                </svg>
              )}
            </button>
          </div>
          {!isLangPanelCollapsed && (
            <div className="h-[calc(100%-42px)] overflow-auto">
              {languages.length === 0 ? (
                <div className="flex items-center justify-center h-full">
                  <div className="text-sm text-gray-500">No languages found</div>
                </div>
              ) : (
                <nav className="flex flex-1 flex-col bg-gray-100 pt-1 pr-2">
                  <ul
                    ref={langListRef}
                    role="list"
                    className="space-y-1 focus:outline-none"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                        e.preventDefault();
                        const currentIndex = languages.findIndex(l => l.name === selectedLang);
                        const nextIndex = (currentIndex + (e.key === 'ArrowUp' ? -1 : 1) + languages.length) % languages.length;
                        const nextLang = languages[nextIndex];
                        handleSelectLanguage(nextLang);
                        langItemRefs.current[nextLang.name]?.scrollIntoView({ block: 'nearest' });
                      }
                    }}
                  >
                    {languages.map((lang) => (
                      <li key={lang.name} ref={(el) => { langItemRefs.current[lang.name] = el; }}>
                        <button
                          onClick={() => { handleSelectLanguage(lang); langListRef.current?.focus(); }}
                          // The description below is truncated to one line; the tooltip is
                          // where the full text stays reachable.
                          title={`${lang.name}\n${lang.description}`}
                          className={classNames(
                            selectedLang === lang.name ? 'bg-gray-300' : 'bg-gray-100 hover:bg-gray-200',
                            "flex flex-col w-full text-left rounded-none py-1 pl-4 pr-2 focus:outline-none"
                          )}
                        >
                          <span className="text-xs font-bold text-gray-700">
                            {lang.name}
                            {lang.status && (
                              <span className="ml-2 font-normal text-gray-500">[{lang.status}]</span>
                            )}
                          </span>
                          <span className="text-xs text-gray-500 truncate">{lang.description}</span>
                          <span className="text-xs text-gray-400">{itemCounts && itemCounts[lang.name] || "0"} items</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </nav>
              )}
            </div>
          )}
        </div>
        {/* Spacer */}
        <div className="w-1 ml-1" />
        {/* Main content area */}
        <div className="flex flex-col grow border border-gray-200 rounded-none h-[calc(100vh-90px)]">
          {selectedLang ? (
            <div className="flex flex-col h-full min-h-0">
              {/* Fixed header: language title + description */}
              <div className="flex-none p-4">
                <h2 className="text-lg font-medium text-gray-800">{selectedLang}</h2>
                <p className="text-sm text-gray-500 mt-4 max-w-[600px]">
                  {langInfo?.description || selectedLanguage?.routingHint || selectedLanguage?.description}
                </p>
                {selectedLanguage?.sponsor && (
                  <p className="text-xs text-gray-400 mt-2">
                    Sponsored by{' '}
                    {selectedLanguage.sponsorUrl ? (
                      <a
                        href={selectedLanguage.sponsorUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:text-gray-600"
                      >
                        {selectedLanguage.sponsor}
                      </a>
                    ) : selectedLanguage.sponsor}
                  </p>
                )}
              </div>
              {/* Scrolling thumbnail grid */}
              <div className="flex-1 min-h-0 overflow-auto px-4 pb-4">
                <ToolsThumbnailGrid
                  items={
                    // undefined until BOTH loads land: passing a partial list would render an
                    // empty grid and flash "No thumbnails yet" before the approvals arrive.
                    //
                    // The snap's mark is the ONLY gate. The source item's own mark used to be
                    // checked here too, which let a mark-5 source silently veto a snap someone
                    // had deliberately promoted — two gates that could disagree about the same
                    // tile (3 of 19 on 2026-09-04). Promotion is the publish decision; nothing
                    // else overrides it.
                    toolItems && snapItems
                      ? toolItems.filter(it => approvedIds.has(it.id))
                      : undefined
                  }
                />
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-gray-400">Select a tool</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
