import { useCallback, useEffect, useState } from 'react';
import useGraffiticodeAuth from '@graffiticode/auth-react';
import { useConsoleSignOut } from '../hooks/use-console-sign-out';
import {
  describeUserAgent,
  endOtherSessions,
  endSession,
  listSessions,
  methodLabel,
  type Session,
} from '../lib/sessions';

const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null;

const ago = (iso: string | null) => {
  if (!iso) return null;
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 60) return 'within the hour';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
};

const details = (s: Session) =>
  [
    methodLabel(s.method),
    s.createdAt && `signed in ${day(s.createdAt)}`,
    s.lastUsedAt && `last active ${ago(s.lastUsedAt)}`,
  ].filter(Boolean).join(' · ');

export default function SessionsCard() {
  const { user } = useGraffiticodeAuth();
  const signOut = useConsoleSignOut();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Sign-outs ask once, inline: "<sessionId>" or "others".
  const [confirming, setConfirming] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      setSessions(await listSessions(await user.getToken()));
    } catch (err: any) {
      setError(err?.message || 'Failed to load sessions');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const act = async (fn: (token: string) => Promise<unknown>) => {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      await fn(await user.getToken());
      setConfirming(null);
      await refresh();
    } catch (err: any) {
      setError(err?.message || 'Failed to sign out');
    } finally {
      setBusy(false);
    }
  };

  const others = sessions.filter((s) => !s.current);

  return (
    <div className="border rounded-none p-4">
      <h3 className="text-lg font-semibold mb-2">Sessions</h3>
      <p className="text-sm text-gray-600 mb-4">
        Where this account is signed in. Sign out of any you don&rsquo;t recognise; it stops
        working within 5 minutes. Sessions last 30 days.
      </p>

      {error && (
        <div className="mb-4 rounded-none bg-red-100 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading && sessions.length === 0 ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : sessions.length > 0 ? (
        <ul className="border border-gray-300 rounded-none mb-4 divide-y">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-2 px-3 py-3">
              <div className="flex flex-col">
                <span className="text-sm text-gray-900">
                  {describeUserAgent(s.userAgent)}
                  {s.current && (
                    <span className="ml-2 whitespace-nowrap text-xs text-gray-500">this browser</span>
                  )}
                </span>
                <small className="text-xs text-gray-500">{details(s)}</small>
                {confirming === s.id && (
                  <span className="text-xs text-gray-700 mt-1">
                    {s.current ? 'Sign out of this browser? ' : 'Sign out this session? '}
                    <button
                      type="button"
                      className="underline text-red-700"
                      disabled={busy}
                      onClick={() => (s.current ? signOut() : act((token) => endSession(token, s.id)))}
                    >
                      Sign out
                    </button>{' '}
                    <button type="button" className="underline" onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                  </span>
                )}
              </div>
              <button
                type="button"
                className="text-sm text-gray-600 hover:text-gray-900 underline"
                disabled={busy}
                onClick={() => setConfirming(s.id)}
              >
                Sign out
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-gray-500 mb-4">No active sessions.</p>
      )}

      {others.length > 0 && sessions.some((s) => s.current) && (
        confirming === 'others' ? (
          <p className="text-sm text-gray-700">
            Sign out of {others.length === 1 ? 'the other session' : `all ${others.length} other sessions`}?{' '}
            <button
              type="button"
              className="underline text-red-700"
              disabled={busy}
              onClick={() => act(endOtherSessions)}
            >
              Sign out
            </button>{' '}
            <button type="button" className="underline" onClick={() => setConfirming(null)}>
              Cancel
            </button>
          </p>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming('others')}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-none border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            Sign out all other sessions
          </button>
        )
      )}
    </div>
  );
}
