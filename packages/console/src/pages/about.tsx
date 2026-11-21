import InstallationCopy from '../components/InstallationCopy';
import { AboutBuiltIn, aboutMarkdownComponents } from '../components/AboutCopy';
import { usePublicConfig } from '../lib/public-config';

// The installation's about page (copy.consoleAbout), or this build's own.
export default function About() {
  const { copy } = usePublicConfig();
  return (
    <div className="flex flex-col text-md leading-7 max-w-2xl font-light mx-auto py-6 sm:px-6 lg:px-8 gap-4">
      <InstallationCopy markdown={copy.consoleAbout} components={aboutMarkdownComponents}>
        <AboutBuiltIn />
      </InstallationCopy>
    </div>
  );
}
