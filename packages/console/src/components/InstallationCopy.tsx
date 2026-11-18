// A page's longer copy (installations plan, P3, slice 3): the installation's
// Markdown from its public configuration (copy.consoleHome, copy.consoleAbout),
// or, when the configuration carries none (only without a profile), this
// build's own content, unchanged. Markdown only: raw HTML isn't rendered, and
// react-markdown's URL transform drops javascript: links.
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';

export default function InstallationCopy({ markdown, className, children }: { markdown: string | null; className?: string; children: ReactNode }) {
  if (markdown === null) return <>{children}</>;
  return (
    <div className={`prose prose-sm prose-blue max-w-none ${className ?? ''}`} data-installation-copy="">
      <ReactMarkdown>{markdown}</ReactMarkdown>
    </div>
  );
}
