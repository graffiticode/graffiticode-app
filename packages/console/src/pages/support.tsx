import { useEffect } from 'react';
import CopyButton from '../components/CopyButton';
import { usePublicConfig } from '../lib/public-config';

const cardClass = 'block bg-gray-50 p-4 border border-gray-200 rounded-none';

// The installation's support channels, from its public configuration: its
// support address, and its support forum (or the forum itself). A channel the
// installation doesn't have isn't shown.
export default function Support() {
  const { brand } = usePublicConfig();
  const email = brand.supportEmail;
  const forum = brand.links.support ?? brand.links.forum;
  return (
    <div className="flex flex-col text-md leading-7 max-w-2xl font-light mx-auto py-6 px-4 sm:px-6 lg:px-8 gap-4">
      <h2 className="font-semibold">Support</h2>
      <p>Need help? Reach us through {email && forum ? 'either of these channels' : 'this channel'}.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {email && <div className={cardClass}>
          <div className="font-medium">Email</div>
          <div className="text-sm text-gray-600">Write to us and we’ll get back to you.</div>
          <div className="mt-2 flex items-center gap-2 text-sm text-gray-900">
            <span className="select-all">{email}</span>
            <CopyButton value={email} title="Copy email address" />
          </div>
        </div>}
        {forum && <a
          href={forum}
          target="_blank"
          rel="noopener noreferrer"
          className={`${cardClass} hover:border-gray-400`}
        >
          <div className="font-medium">Forum</div>
          <div className="text-sm text-gray-600">Ask questions and search answers in the community support forum.</div>
          <div className="mt-2 text-sm text-blue-600 hover:underline">{new URL(forum).host}</div>
        </a>}
      </div>
    </div>
  );
}
