// The console home page's welcome copy: the built-in content, and the element
// mapping an installation's Markdown (copy.consoleHome) renders with. Both use
// the same classes, inside the page's flex column (centered, gap-4).
//
// The built-in body is one paragraph, with the signed-out note after a blank
// line (<br /><br />). Markdown gives the note its own paragraph; the column's
// gap is 1rem, so a paragraph that follows another adds 0.25rem, making the
// blank line's 1.25rem (text-sm's line height).
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Components } from 'react-markdown';

export const HOME_HEADING = 'text-2xl font-medium text-gray-700';
export const HOME_BODY = 'text-sm text-gray-500 text-justify w-1/2';
export const HOME_LINK = 'text-blue-600 hover:underline';

function CopyLink({ href, children }: { href?: string; children?: ReactNode }) {
  // Site paths navigate within the app, as the built-in links do.
  if (href?.startsWith('/') && !href.startsWith('//')) return <Link href={href} className={HOME_LINK}>{children}</Link>;
  return <a href={href} className={HOME_LINK}>{children}</a>;
}

export const homeMarkdownComponents: Components = {
  h1: ({ children }) => <h1 className={HOME_HEADING}>{children}</h1>,
  h2: ({ children }) => <h2 className={HOME_HEADING}>{children}</h2>,
  p: ({ children }) => <p className={`${HOME_BODY} [p+&]:mt-1`}>{children}</p>,
  a: ({ href, children }) => <CopyLink href={href}>{children}</CopyLink>,
};

export function HomeBuiltIn({ signedIn }: { signedIn: boolean }) {
  return (
    <>
      <h1 className={HOME_HEADING}>Welcome to Graffiticode</h1>
      <p className={HOME_BODY}>
        Graffiticode is a platform for deploying smart tools for agents and humans.
        Visit our <Link href="/support" className={HOME_LINK}>Support</Link> page to learn more.
        If you are feeling adventurous go straight to <Link href="/tools" className={HOME_LINK}>Tools</Link> to see what you can make with Graffiticode.
        {!signedIn && (
          <>
            <br /><br />
            New here? Create a free account by signing in with an Ethereum wallet. No blockchain fees required. No credit card required.
          </>
        )}
      </p>
    </>
  );
}
