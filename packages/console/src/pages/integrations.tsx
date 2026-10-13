import { useEffect } from 'react';
import IntegrationsCard from '../components/IntegrationsCard';
import SignIn from '../components/SignIn';
import useGraffiticodeAuth from '@graffiticode/auth-react';
import { getPageTitle } from '../lib/utils';

export default function Integrations() {
  const { user } = useGraffiticodeAuth();

  useEffect(() => {
    document.title = getPageTitle();
  }, []);

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
    <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
      <div className="relative pt-10">
        <div className="border lg:grid lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x">
          <aside className="py-6 lg:col-span-3">
            <span className="mx-5 text-xl font-bold">Integrations</span>
          </aside>
          <div className="lg:col-span-9">
            <IntegrationsCard />
          </div>
        </div>
      </div>
    </div>
  );
}
