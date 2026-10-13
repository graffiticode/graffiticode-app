import { useCallback, useEffect, useState } from 'react';
import { PlusIcon, TrashIcon } from '@heroicons/react/24/outline';
import useGraffiticodeAuth from '@graffiticode/auth-react';
import { useLinkedEmails, type LinkedEmail } from '../hooks/use-linked-emails';
import AddEmailDialog from './AddEmailDialog';

export default function LinkedEmailsCard() {
  const { user } = useGraffiticodeAuth();
  const { listEmails, removeEmail } = useLinkedEmails();

  const [emails, setEmails] = useState<LinkedEmail[]>([]);
  // The address the account was created with. Its row is NOT removable: unlike an
  // added email, it is not merely a stored credential — it derives the account's
  // Privy embedded wallet, so deleting the row would hide it without revoking
  // anything. A delete button that silently fails to revoke is worse than none.
  const [signInEmail, setSignInEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!user?.uid) return;
    setLoading(true);
    setError(null);
    try {
      const token = await user.getToken();
      const [rows, userDoc] = await Promise.all([
        listEmails(),
        fetch(`/api/user/${user.uid}`, { headers: { Authorization: token } })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);
      setEmails(rows);
      setSignInEmail(typeof userDoc?.signInEmail === 'string' ? userDoc.signInEmail : null);
    } catch (err: any) {
      setError(err?.message || 'Failed to load linked emails');
    } finally {
      setLoading(false);
    }
  }, [user, listEmails]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleRemove = async (id: string) => {
    setRemovingId(id);
    setError(null);
    try {
      await removeEmail(id);
      setEmails((prev) => prev.filter((e) => e.id !== id));
    } catch (err: any) {
      setError(err?.message || 'Failed to remove email');
    } finally {
      setRemovingId(null);
    }
  };

  const handleAdded = (email: string) => {
    setShowAdd(false);
    refresh();
    // Optimistic feedback — refresh fetches the new row from the server.
    setError(null);
    void email;
  };

  return (
    <div className="border rounded-none p-4">
      <h3 className="text-lg font-semibold mb-2">Linked Emails</h3>
      <p className="text-sm text-gray-600 mb-4">
        Emails linked to this account. Any of them can be used to sign in. The address the
        account was created with is marked as its sign-in identity and can&rsquo;t be removed.
      </p>

      {error && (
        <div className="mb-4 rounded-none bg-red-100 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading && emails.length === 0 ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : emails.length > 0 ? (
        <ul className="border border-gray-300 rounded-none mb-4 divide-y">
          {emails.map((row) => {
            const isSignInIdentity =
              !!signInEmail && row.email.toLowerCase() === signInEmail.toLowerCase();
            return (
              <li
                key={row.id}
                className="flex items-center justify-between gap-2 px-3 py-3"
              >
                <span className="text-sm text-gray-900 break-all">
                  {row.email}
                  {isSignInIdentity && (
                    <span className="ml-2 whitespace-nowrap text-xs text-gray-500">
                      sign-in identity
                    </span>
                  )}
                </span>
                {!isSignInIdentity && (
                  <button
                    type="button"
                    onClick={() => handleRemove(row.id)}
                    disabled={removingId === row.id}
                    className="text-red-500 hover:text-red-700 disabled:opacity-50"
                    title="Remove email"
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-gray-500 mb-4">No emails linked yet.</p>
      )}

      <button
        type="button"
        onClick={() => setShowAdd(true)}
        className="inline-flex items-center gap-2 rounded-none border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
      >
        <PlusIcon className="h-4 w-4" />
        Add email
      </button>

      <AddEmailDialog
        isOpen={showAdd}
        onClose={() => setShowAdd(false)}
        onAdded={handleAdded}
      />
    </div>
  );
}
