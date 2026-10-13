import { useState } from 'react';

export default function InviteCodeDialog({ open, onClose, onSubmit }) {
  const [inviteCode, setInviteCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await onSubmit(inviteCode);
    } catch (err) {
      setError(err.message || 'Invalid invite code');
    } finally {
      setLoading(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black bg-opacity-50" onClick={onClose} />
      <div className="relative bg-white rounded-none shadow-xl p-6 w-full max-w-sm">
        <h2 className="text-xl font-semibold mb-4">Invite Code</h2>
        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <input
              id="invite-code"
              type="text"
              className="w-full px-3 py-2 border border-gray-300 rounded-none focus:outline-none focus:ring-1 focus:ring-gray-400 focus:border-gray-400"
              placeholder="Enter your invite code"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              disabled={loading}
              autoFocus
            />
            {error && (
              <p className="mt-2 text-sm text-red-600">{error}</p>
            )}
          </div>
          <div className="flex justify-end space-x-2">
            <button
              type="button"
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-none hover:bg-gray-200 disabled:opacity-50"
              onClick={onClose}
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-sm font-medium text-white bg-gray-600 rounded-none hover:bg-gray-700 disabled:opacity-50"
              disabled={loading || !inviteCode.trim()}
            >
              {loading ? 'Verifying...' : 'Submit'}
            </button>
          </div>
          <p className="mt-4 text-xs text-gray-600 text-left">
            DM jeff on our{' '}
            <a href="https://forum.graffiticode.org/c/support" className="underline">Support</a>{' '}
            forum if you need an invite code.
          </p>
        </form>
      </div>
    </div>
  );
}
