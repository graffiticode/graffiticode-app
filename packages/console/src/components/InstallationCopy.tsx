// A page's longer copy (installations plan, P3, slice 3): the installation's
// Markdown from its public configuration (copy.consoleHome, copy.consoleAbout),
// or, when the configuration carries none (only without a profile), this
// build's own content, unchanged. Markdown only: raw HTML isn't rendered, and
// react-markdown's URL transform drops javascript: links.
//
// The Markdown is rendered with the page's own element mapping (`components`)
// and no wrapper element: react-markdown renders a fragment, so its blocks
// land in the page's own container, with the same layout, typography and
// spacing as the built-in content (HomeCopy.tsx, AboutCopy.tsx).
import type { ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';

export default function InstallationCopy({ markdown, components, children }: { markdown: string | null; components: Components; children?: ReactNode }) {
  if (markdown === null) return <>{children}</>;
  return <ReactMarkdown components={components}>{markdown}</ReactMarkdown>;
}
