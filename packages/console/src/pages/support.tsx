import { useEffect } from 'react';
import { getPageTitle } from '../lib/utils';
import CopyButton from '../components/CopyButton';

const cardClass = 'block bg-gray-50 p-4 border border-gray-200 rounded-none';

export default function Support() {
  useEffect(() => {
    document.title = getPageTitle();
  }, []);
  return (
    <div className="flex flex-col text-md leading-7 max-w-2xl font-light mx-auto py-6 px-4 sm:px-6 lg:px-8 gap-4">
      <h2 className="font-semibold">Support</h2>
      <p>Need help? Reach us through either of these channels.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className={cardClass}>
          <div className="font-medium">Email</div>
          <div className="text-sm text-gray-600">Write to us and we’ll get back to you.</div>
          <div className="mt-2 flex items-center gap-2 text-sm text-gray-900">
            <span className="select-all">support@graffiticode.org</span>
            <CopyButton value="support@graffiticode.org" title="Copy email address" />
          </div>
        </div>
        <a
          href="https://forum.graffiticode.org/c/support/57"
          target="_blank"
          rel="noopener noreferrer"
          className={`${cardClass} hover:border-gray-400`}
        >
          <div className="font-medium">Forum</div>
          <div className="text-sm text-gray-600">Ask questions and search answers in the community support forum.</div>
          <div className="mt-2 text-sm text-blue-600 hover:underline">forum.graffiticode.org</div>
        </a>
      </div>
    </div>
  );
}
