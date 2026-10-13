import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useToken } from '@graffiticode/auth-react';
import { getPageTitle } from '../../lib/utils';
import { getBaseUrlForApi, getLanguageAsset } from "../../lib/api";

/** Fixed per page load: a fresh visit busts the cache, a re-render does not reload the frame. */
const PAGE_LOAD = Date.now();

type View = 'spec' | 'usage-guide' | 'instructions';

const VIEW_FILES: Record<Exclude<View, 'spec'>, string> = {
  'usage-guide': 'usage-guide.md',
  'instructions': 'instructions.md',
};

function parseView(raw: unknown): View {
  const v = Array.isArray(raw) ? raw[0] : raw;
  // Accept `user-guide` as a legacy alias so existing bookmarks still resolve.
  if (v === 'usage-guide' || v === 'user-guide') return 'usage-guide';
  if (v === 'instructions') return 'instructions';
  return 'spec';
}

function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s+/, '');
}

export default function Spec({ language }) {
  const router = useRouter();
  const langId = language.name.slice(1);
  const view = parseView(router.query.view);
  const { data: accessToken } = useToken();

  const [markdown, setMarkdown] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    document.title = getPageTitle();
  }, []);

  // Canonicalize /specs → /specs/<langId> so subsequent language changes are
  // handled by the bidirectional URL↔selector sync in /specs/[id].
  useEffect(() => {
    if (!router.isReady) return;
    if (!langId) return;
    router.replace({ pathname: `/specs/${langId}`, query: router.query }, undefined, { shallow: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, langId]);

  useEffect(() => {
    if (view === 'spec') return;
    let cancelled = false;
    setMarkdown(null);
    setLoading(true);
    (async () => {
      let text = await getLanguageAsset(`L${langId}`, VIEW_FILES[view], accessToken);
      // Languages mid-migration may still serve `user-guide.md`; fall back.
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
