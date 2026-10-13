import { ClipboardDocumentIcon, ClipboardDocumentCheckIcon } from "@heroicons/react/24/outline";
import React, { useState } from "react";

// Extracted from NewAPIKeyDialog so the claim page's connect instructions copy
// config snippets the same way the key dialog copies a secret.
export default function CopyButton({ value, title = "Copy to clipboard" }: { value: string; title?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <button type="button" onClick={handleCopy} title={title}>
      {copied ? (
        <ClipboardDocumentCheckIcon className="h-5 w-5 text-green-600" />
      ) : (
        <ClipboardDocumentIcon className="h-5 w-5 text-gray-500 hover:text-gray-700" />
      )}
    </button>
  );
}
