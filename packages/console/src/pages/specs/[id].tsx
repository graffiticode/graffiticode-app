import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useToken } from '@graffiticode/auth-react';
import { getPageTitle } from '../../lib/utils';
import { getBaseUrlForApi, getLanguageAsset } from '../../lib/api';
import { findLanguageByNumber } from '../../components/language-selector';

/** Fixed per page load: a fresh visit busts the cache, a re-render does not reload the frame. */
const PAGE_LOAD = Date.now();

type View = 'spec' | 'usage-guide' | 'instructions';

const VIEW_FILES: Record<Exclude<View, 'spec'>, string> = {
  'usage-guide': 'usage-guide.md',
  'instructions': 'instructions.md',
};

function parseView(raw: unknown): View {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === 'usage-guide' || v === 'user-guide') return 'usage-guide';
  if (v === 'instructions') return 'instructions';
  return 'spec';
}

function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s+/, '');
}

function normalizeLangId(raw: any): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/^L/i, '').trim();
  if (!s) return null;
  return s.padStart(4, '0');
}

export default function SpecDetail({ language, setLanguage }) {
  const router = useRouter();
  const rawId = router.query.id;
  const urlLangId = normalizeLangId(Array.isArray(rawId) ? rawId[0] : rawId);
  const selectorLangId = normalizeLangId(language?.name);
  const langId = urlLangId || selectorLangId || '';
  const view = parseView(router.query.view);
  const { data: accessToken } = useToken();

  const [markdown, setMarkdown] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    document.title = getPageTitle();
  }, []);

  // URL → selector: when the user pastes /specs/0166 with a different selector,
  // sync the selector to the URL segment. Only fires when the two disagree.
  useEffect(() => {
    if (!urlLangId) return;
    if (urlLangId === selectorLangId) return;
    if (!setLanguage) return;
    const next = findLanguageByNumber(urlLangId);
    if (next) setLanguage(next);
  }, [urlLangId, selectorLangId, setLanguage]);

  // Selector → URL: when the user picks a new language while on /specs/[id],
  // canonicalize the URL to match. Equality guard prevents a feedback loop
  // with the URL→selector effect above.
  useEffect(() => {
    if (!router.isReady) return;
    if (!selectorLangId) return;
    if (selectorLangId === urlLangId) return;
    const query = { ...router.query };
    delete query.id;
    router.replace({ pathname: `/specs/${selectorLangId}`, query }, undefined, { shallow: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectorLangId]);

  useEffect(() => {
    if (!langId) return;
    if (view === 'spec') return;
    let cancelled = false;
    setMarkdown(null);
    setLoading(true);
    (async () => {
      let text = await getLanguageAsset(`L${langId}`, VIEW_FILES[view], accessToken);
      if (text === null && view === 'usage-guide') {
        text = await getLanguageAsset(`L${langId}`, 'user-guide.md', accessToken);
      }
      if (cancelled) return;
      setMarkdown(text === null ? null : stripHtmlComments(text));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [langId, view, accessToken]);

  const remarkPlugins = useMemo(() => [remarkGfm], []);

  if (!langId) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-6">
        <div className="text-sm text-gray-500">No language selected.</div>
      </div>
    );
  }

  if (view === 'spec') {
    // An iframe can't send an Authorization header, so pass the token as a
    // query param (the API accepts ?access_token) to resolve any per-user
    // language-server override for the rendered spec.
    // `_cb` defeats the `max-age=3600` api.graffiticode.org serves spec.html with, which
    // otherwise shows the pre-deploy spec for up to an hour (getLanguageAsset does the same).
    const src = accessToken
      ? `${getBaseUrlForApi()}/L${langId}/spec.html?_cb=${PAGE_LOAD}&access_token=${encodeURIComponent(accessToken)}`
      : `${getBaseUrlForApi()}/L${langId}/spec.html?_cb=${PAGE_LOAD}`;
    return (
      <iframe
        className="w-full h-screen"
        width="100%"
        height="100%"
        src={src}
      />
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-6">
      {loading && <div className="text-sm text-gray-500">Loading…</div>}
      {!loading && markdown === null && (
        <div className="text-sm text-gray-500">
          Not available for L{langId}.
        </div>
      )}
      {!loading && markdown !== null && (
        <div className="prose prose-sm prose-blue max-w-none">
          <ReactMarkdown remarkPlugins={remarkPlugins}>
            {markdown}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}
