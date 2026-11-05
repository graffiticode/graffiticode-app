import { useEffect } from 'react';
import { getPageTitle } from '../lib/utils';

const options = [
  {
    name: 'Email',
    description: 'Write to us and we’ll get back to you.',
    label: 'support@graffiticode.org',
    href: 'mailto:support@graffiticode.org',
  },
  {
    name: 'Forum',
    description: 'Ask questions and search answers in the community support forum.',
    label: 'forum.graffiticode.org',
    href: 'https://forum.graffiticode.org/c/support/57',
    external: true,
  },
];

export default function Support() {
  useEffect(() => {
    document.title = getPageTitle();
  }, []);
  return (
    <div className="flex flex-col text-md leading-7 max-w-2xl font-light mx-auto py-6 px-4 sm:px-6 lg:px-8 gap-4">
      <h2 className="font-semibold">Support</h2>
      <p>Need help? Reach us through either of these channels.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {options.map((option) => (
          <a
            key={option.name}
            href={option.href}
            target={option.external ? '_blank' : undefined}
            rel={option.external ? 'noopener noreferrer' : undefined}
            className="block bg-gray-50 p-4 border border-gray-200 rounded-none hover:border-gray-400"
          >
            <div className="font-medium">{option.name}</div>
            <div className="text-sm text-gray-600">{option.description}</div>
            <div className="mt-2 text-sm text-blue-600 hover:underline">{option.label}</div>
          </a>
        ))}
      </div>
    </div>
  );
}
