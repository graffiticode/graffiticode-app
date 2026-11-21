// The console about page's copy: the built-in content, and the element mapping
// an installation's Markdown (copy.consoleAbout) renders with, inside the
// page's column (font-light, leading-7, gap-4). Both share the same headings,
// inline styles and callout, so a profile's About looks like the built-in one.
//
// Markdown to built-in: headings are font-semibold; **strong** and *em* are
// <b> and <i>; links have no styling of their own; a blockquote is the icon
// callout, where a leading **strong** is the callout's font-medium lead-in
// ("What's missing?") and a **strong** inside a link stays <b>.
import Link from 'next/link';
import { createContext, useContext, type ReactNode } from 'react';
import type { Components } from 'react-markdown';

export const ABOUT_HEADING = 'font-semibold';

export function AboutCallout({ children }: { children: ReactNode }) {
  return (
    <div className="bg-gray-50 p-4 font-normal border border-1 rounded-none grid grid-cols-12">
      <div className="col-span-1 mt-1 ml-1">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="size-5">
          <path fillRule="evenodd" d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0ZM8.94 6.94a.75.75 0 1 1-1.061-1.061 3 3 0 1 1 2.871 5.026v.345a.75.75 0 0 1-1.5 0v-.5c0-.72.57-1.172 1.081-1.287A1.5 1.5 0 1 0 8.94 6.94ZM10 15a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
        </svg>
      </div>
      <div className="col-span-11 pr-4 font-light">
        {children}
      </div>
    </div>
  );
}

const InCallout = createContext(false);
const InLink = createContext(false);

function CopyLink({ href, children }: { href?: string; children?: ReactNode }) {
  const inner = <InLink.Provider value={true}>{children}</InLink.Provider>;
  // Site paths navigate within the app, as the built-in links do.
  if (href?.startsWith('/') && !href.startsWith('//')) return <Link href={href}>{inner}</Link>;
  return <a href={href}>{inner}</a>;
}

function Strong({ children }: { children?: ReactNode }) {
  const callout = useContext(InCallout);
  const link = useContext(InLink);
  if (callout && !link) return <span className="font-medium">{children}</span>;
  return <b>{children}</b>;
}

// Inside the callout, a paragraph's text sits directly in the callout's column.
function Paragraph({ children }: { children?: ReactNode }) {
  return useContext(InCallout) ? <>{children}</> : <p>{children}</p>;
}

export const aboutMarkdownComponents: Components = {
  h1: ({ children }) => <h2 className={ABOUT_HEADING}>{children}</h2>,
  h2: ({ children }) => <h2 className={ABOUT_HEADING}>{children}</h2>,
  h3: ({ children }) => <h3 className={ABOUT_HEADING}>{children}</h3>,
  p: ({ children }) => <Paragraph>{children}</Paragraph>,
  strong: ({ children }) => <Strong>{children}</Strong>,
  em: ({ children }) => <i>{children}</i>,
  a: ({ href, children }) => <CopyLink href={href}>{children}</CopyLink>,
  ul: ({ children }) => <ul className="list-disc pl-6">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-6">{children}</ol>,
  blockquote: ({ children }) => (
    <InCallout.Provider value={true}>
      <AboutCallout>{children}</AboutCallout>
    </InCallout.Provider>
  ),
};

export function AboutBuiltIn() {
  return (
    <>
      <h2 className={ABOUT_HEADING}>
        Welcome to Graffiticode
      </h2>
      <p>
        Graffiticode is a tool for programming web components and apis through
        task specific languages. It is first and foremost a collection of
        end-user programming languages with runtimes that are React components
        and GraphQL services.
      </p>
      <p>
        By <i>end-user</i> we don&apos;t mean non-technical,
        but rather the user of the thing being programmed. Just as
        accountants are the end-users of the spreadsheets they create to do work
        for their customers, the designers and developers or whoever else are
        making software with Graffiticode are its end-users.
      </p>
      <h2 className={ABOUT_HEADING}>
        Getting started
      </h2>
      <p>
        Get started by signing in the Graffiticode using your preferred Ethereum
        wallet. <i>MetaMask</i> and <i>Coinbase</i> are two of the more popular wallets.
      </p>
      <p>
        After signing in, you can start building by navigating to the&nbsp;
        <Link href="/tools"><b>Tools</b></Link>
        &nbsp;tab, selecting a language, and start writing code.
      </p>
      <AboutCallout>
        <span className="font-medium">What&apos;s missing? </span>
        There are of course many many more languages we could add to the current
        collection. What programmable components and apis would you like to see
        here?&nbsp;
        <a href="mailto: jeff@graffiticode.com?subject=Graffiticode language idea"><b>Send us a note!</b></a>
      </AboutCallout>
      <h2 className={ABOUT_HEADING}>
        Main ideas
      </h2>
      <p>
        Graffiticode is a <b>language-oriented</b> programming tool. At the
        core of every component and api is a task-oriented language that is used
        to customize its feel and function. On the frontend, code defines the
        initial state of user interface components. On the backend, code defines
        how data is transformed.
      </p>
      <p>
        Framed using <b>MVC</b> ideas, you can think of the language as an
        abstract <b>model</b>, the frontend as the <b>view</b>, and the
        integration between them as the <b>controller</b>. Without specifying
        an implementation, the language defines an infinite class of models that
        is selected from by code in that language.
      </p>
      <p>
        <b>Languages.</b> Thinking of language as an abstract model that is made
        concrete by code helps to illuminate the power of the language-oriented
        programming paradigm. It allows us to create meta-models for a class of
        models that are selected from later in the development process. It also
        makes model building more accessible to the non-developers who are often
        more proximate the problem spaces for which the models are being created.
      </p>
      <p>
        <b>Tasks.</b> The components and apis are programmed with the&nbsp;
        <Link href="/items"><b>Items</b></Link>
        &nbsp;editor. Once programmed, the static state of the component or api
        is used to initialize them whereever and however they may be hosted.
      </p>
      <p>
        <b>Compiles.</b> Code and data are compiled to data by being posted to a
        language service. Compiles are idemponent and thus yield the same output
        given the same input. This allows us to identify and cache the output of
        compiles by a hash for their task language and code and data. The&nbsp;
        <Link href="/tasks"><b>Tasks</b></Link>
        &nbsp;tab shows the cached compiles performed through the
        <i> Graffiticode Console</i> and <i>API Gateway</i>.
      </p>
      <h2 className={ABOUT_HEADING}>
        Hosting
      </h2>
      <p>
        React components are installed using your chosen <i>npm</i> package
        installer. GraphQL services are either self-hosted or managed by an
        hosting provider such as Graffiticode.
      </p>
    </>
  );
}
