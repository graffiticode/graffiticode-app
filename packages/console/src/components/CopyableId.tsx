import { useState } from 'react';

function classNames(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(' ');
}

interface Props {
  // The full value copied to the clipboard.
  value: string;
  // Optional shorter text to show (e.g. an elided compound id). Defaults to value.
  display?: string;
  className?: string;
  title?: string;
}

// An id rendered as click-to-copy text (no button), matching the Item ID field
// in the item menu. Clicking copies the full value and briefly shows "Copied!".
export default function CopyableId({ value, display, className, title = 'Click to copy' }: Props) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className={classNames(
        'text-xs font-mono text-gray-600 hover:text-gray-900 cursor-pointer py-1.5 truncate',
        className,
      )}
      onClick={() => {
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1000);
      }}
      title={title}
    >
      {copied ? (
        <span className="text-green-500 inline-flex items-center">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 mr-1">
            <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clipRule="evenodd" />
          </svg>
          Copied!
        </span>
      ) : (
        display ?? value
      )}
    </div>
  );
}
