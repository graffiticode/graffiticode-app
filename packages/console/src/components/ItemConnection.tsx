import { useEffect, useState } from 'react';
import Link from 'next/link';
import { loadCurrentConnections, republishItem, retryItemWrite } from '../utils/swr/fetchers';
import { backendForLang, normalizeLang } from '../lib/connectable';
import { getCredentialBackend } from '../lib/credential-backends';
import { canRetryWrite, describeWriteProblem } from '../lib/write-errors';

// Fired after a write through a connection, so the preview (which shows the
// stored result) reloads: a write changes that result without changing the item.
export const ITEM_RUN_EVENT = 'gc:item-run';

const errorText = err => String(err?.response?.errors?.[0]?.message || err?.message || err);

// Where an item's saves go. Every save of a new version writes through the
// user's current connection for the language (chosen in Settings, system-wide),
// and the outcome is shown here with a Retry that reuses the save's idempotency
// key, so a lost response never repeats a write. Publishing is per item.
export default function ItemConnection({ user, itemId, lang, taskId, connectionId, publicationId, publicationConnectionId = null, publishedTaskId = null, lastWrite = null, onChanged }) {
  const [current, setCurrent] = useState(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    let live = true;
    loadCurrentConnections({ user })
      .then(list => live && setCurrent((list || []).find(c => c.lang === normalizeLang(lang)) || null))
      .catch(() => live && setCurrent(null));
    return () => { live = false; };
  }, [user, lang, connectionId]);

  const backend = backendForLang(lang);
  const service = getCredentialBackend(backend)?.label || backend;
  const labelFor = c => `${c.label || `${c.backend} ${c.connectionId.slice(-6)}`}${c.shared ? ' (shared with you)' : ''}`;
  const connectionLabel = id => {
    const c = current?.candidates?.find(c => c.connectionId === id);
    return c ? labelFor(c) : current ? 'a connection no longer available' : 'your connection';
  };

  const act = async (fn, done) => {
    setBusy(true);
    setMessage(null);
    try {
      const item = await fn();
      done?.(item);
      onChanged?.();
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const retry = () => act(() => retryItemWrite({ user, id: itemId }), item => {
    if (item?.lastWrite?.status === 'ok') {
      window.dispatchEvent(new CustomEvent(ITEM_RUN_EVENT, { detail: { itemId } }));
    }
  });

  // A published item keeps showing the version (and connection) it was
  // published with until the owner republishes, so an edit never reaches
  // learners half-finished.
  const republish = () => act(() => republishItem({ user, id: itemId }), () => setMessage('Republished the current version.'));

  // The write for THIS version through THIS connection; older outcomes are history.
  const write = lastWrite && lastWrite.taskId === taskId && lastWrite.connectionId === connectionId ? lastWrite : null;
  // A failed or skipped write of THIS version, through whichever connection it
  // tried (the current one may have changed since, or there was none).
  const problemWrite = lastWrite && lastWrite.taskId === taskId ? lastWrite : null;
  const problem = taskId ? describeWriteProblem(problemWrite) : null;
  const showRetry = canRetryWrite(problem, problemWrite, connectionId);
  const staleVersion = Boolean(publicationId && publishedTaskId && publishedTaskId !== taskId);
  const staleConnection = Boolean(publicationId && connectionId && publicationConnectionId && publicationConnectionId !== connectionId);
  const buttonClass = 'px-3 py-1 text-xs text-gray-700 border border-gray-300 hover:bg-gray-100 rounded-none disabled:opacity-50';

  return (
    <div className="mt-4">
      <label className="block text-xs font-semibold text-gray-600 mb-1">Connection</label>
      {current === undefined ? (
        <div className="text-xs text-gray-500">Loading…</div>
      ) : connectionId ? (
        <div className="text-xs text-gray-700">
          Saves write through {connectionLabel(connectionId)}.{' '}
          <Link href="/settings" className="underline text-gray-500 hover:text-gray-900">Change</Link>
        </div>
      ) : (
        <div className="text-xs text-gray-500">
          {current?.candidates?.length > 1
            ? <>No current {service} connection — previews only. <Link href="/settings" className="underline hover:text-gray-900">Choose one in Settings.</Link></>
            : <>No {service} connection — previews only. <Link href="/settings" className="underline hover:text-gray-900">Add one in Settings.</Link></>}
        </div>
      )}
      {problem ? (
        <div className="text-xs text-gray-600 mt-1 break-words">
          <div title={problemWrite?.message || undefined}>{problem.headline}: {problem.text}</div>
          {showRetry && (
            <button onClick={retry} disabled={busy} className={`mt-1 ${buttonClass}`}>
              {busy ? 'Writing…' : 'Retry'}
            </button>
          )}
        </div>
      ) : connectionId && taskId && (
        write?.status === 'ok' ? (
          <div className="text-xs text-green-700 mt-1">Saved to {service}.</div>
        ) : (
          <div className="text-xs text-gray-500 mt-1">Not written through this connection yet. Recompile writes it.</div>
        )
      )}
      {publicationId && !staleVersion && !staleConnection && (
        <div className="text-xs text-gray-500 mt-1">Published through {publicationConnectionId ? connectionLabel(publicationConnectionId) : 'a connection'}.</div>
      )}
      {(staleVersion || staleConnection) && (
        <div className="text-xs text-gray-600 mt-2">
          <div>
            {staleVersion
              ? 'The published version is older than the current one.'
              : 'It is published through a different connection than the current one.'}
            {' '}Republish to publish the current version through the current connection.
          </div>
          <button onClick={republish} disabled={busy || !connectionId} className={`mt-1 ${buttonClass}`}>
            Republish
          </button>
        </div>
      )}
      {message && <div className="text-xs text-gray-600 mt-1 break-words">{message}</div>}
    </div>
  );
}
