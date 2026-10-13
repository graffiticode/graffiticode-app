import { TrashIcon, PlusIcon, ArrowPathIcon, NoSymbolIcon, UserPlusIcon } from "@heroicons/react/24/outline";
import { useState, useEffect, useCallback } from "react";
import useGraffiticodeAuth from "@graffiticode/auth-react";
import {
  loadConnections,
  createConnection,
  rotateConnection,
  disableConnection,
  deleteConnection,
  leaveSharedConnection,
  loadCurrentConnections,
  setCurrentConnection,
} from "../utils/swr/fetchers";
import ConnectionSharing from "./ConnectionSharing";
import CopyableId from "./CopyableId";
import { CREDENTIAL_BACKENDS, getCredentialBackend } from "../lib/credential-backends";
import { CONNECTABLE_LANGS } from "../lib/connectable";

interface Connection {
  connectionId: string;
  backend: string;
  status: "active" | "disabled";
  label: string | null;
  // A Graffiticode system connection: signs previews only, never used for
  // saves, so it is never offered as a current connection. Absent from an
  // older api.
  system?: boolean;
  shared: boolean;
  permissions: { lang: string; fn: string }[] | null;
  expiresAt: string | null;
  // For a shared connection: who shared it (profile name, or short ID).
  sharedBy?: { name: string; shortId: string } | null;
  // For an owned connection: what the owner allows themselves (null: everything).
  ownerPermissions?: { lang: string; fn: string }[] | null;
}

interface CurrentConnection {
  lang: string;
  backend: string;
  connectionId: string | null;
  explicit: boolean;
  candidates: Connection[];
}

// A connection holds an external-API credential in the credential broker; items
// run through it without ever seeing the credential. Its owner can use it,
// limit their own use of it and share it (ConnectionSharing: one access table
// per connection); people it is shared with see it here as
// "Shared with you" and can leave. The secret is sent once and never shown again.
const errorText = (err: any) =>
  String(err?.response?.errors?.[0]?.message || err?.message || err).replace(/^Connection request refused: /, "Refused: ");

export default function ConnectionsCard() {
  const { user } = useGraffiticodeAuth();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [current, setCurrent] = useState<CurrentConnection[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // One open form at a time: "add", or "rotate:<connectionId>".
  const [form, setForm] = useState<string | null>(null);
  const [backend, setBackend] = useState(CREDENTIAL_BACKENDS[0]?.key || "learnosity");
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  // Destructive actions ask once, inline: "disable:<id>" or "delete:<id>".
  const [confirming, setConfirming] = useState<string | null>(null);
  // The owned connection whose find-and-share form is open.
  const [sharing, setSharing] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      const [list, currentList] = await Promise.all([loadConnections({ user }), loadCurrentConnections({ user })]);
      setConnections(list || []);
      setCurrent(currentList || []);
      setStatus("ready");
    } catch (err) {
      setError(errorText(err));
      setStatus("error");
    }
  }, [user]);

  useEffect(() => { refresh(); }, [refresh]);

  const resetForm = () => {
    setForm(null);
    setLabel("");
    setKey("");
    setSecret("");
    setError(null);
  };

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      resetForm();
      setConfirming(null);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (!key.trim() || !secret.trim()) {
      setError("Enter both the key and the secret.");
      return;
    }
    if (form === "add") {
      act(() => createConnection({ user, backend, label: label.trim() || null, key: key.trim(), secret: secret.trim() }));
    } else if (form?.startsWith("rotate:")) {
      act(() => rotateConnection({ user, connectionId: form.slice("rotate:".length), key: key.trim(), secret: secret.trim() }));
    }
  };

  const backendLabel = (b: string) => getCredentialBackend(b)?.label || b;
  // One line naming a connection, the same for owned and shared rows: the
  // service first (what it connects to), then the owner's label for it, its
  // status, and the end of its id.
  const rowHeading = (c: Connection) => (
    <div className="flex flex-wrap items-baseline gap-x-3">
      <span className="font-medium text-gray-900">{backendLabel(c.backend)}</span>
      {c.label && <span className="font-mono">{c.label}</span>}
      <span className={`text-sm ${c.status === "active" ? "text-green-700" : "text-gray-500"}`}>{c.status}</span>
      <span className="font-mono text-sm text-neutral-500">{c.connectionId.slice(-8)}</span>
    </div>
  );
  // Current connection per connectable language: a radio on each candidate row,
  // exclusive per language across all rows. A system connection, a disabled one,
  // or a shared one whose grant doesn't cover the language is never a candidate.
  const connectable = current.filter(cc => Object.prototype.hasOwnProperty.call(CONNECTABLE_LANGS, cc.lang));
  const unchosen = connectable.filter(cc => !cc.connectionId && cc.candidates.some(x => !x.system));
  // Languages with nothing to write through: saves stay previews until a
  // connection for the backend is added (or shared with the user).
  const uncovered = status === "ready" ? connectable.filter(cc => !cc.candidates.some(x => !x.system)) : [];
  const currentRadios = (c: Connection) => {
    if (c.system) return null;
    const langs = connectable.filter(cc => cc.candidates.some(x => x.connectionId === c.connectionId));
    if (langs.length === 0) return null;
    return (
      <span className="flex flex-wrap gap-x-4 mt-1">
        {langs.map(cc => {
          const checked = cc.connectionId === c.connectionId;
          return (
            <label key={cc.lang} className="inline-flex items-center gap-1.5 text-xs text-gray-700">
              <input
                type="radio"
                name={`current-connection-${cc.lang}`}
                value={c.connectionId}
                checked={checked}
                disabled={busy}
                onChange={() => act(() => setCurrentConnection({ user, lang: cc.lang, connectionId: c.connectionId }))} />
              <span>
                Current for L{cc.lang}
                {checked && !cc.explicit && <span className="text-gray-500"> (automatic)</span>}
              </span>
            </label>
          );
        })}
      </span>
    );
  };
  const rotating = form?.startsWith("rotate:") ? form.slice("rotate:".length) : null;

  const formView = (
    <div className="border border-gray-300 p-4 space-y-3 rounded-none">
      {form === "add" && (
        <>
          <label className="block text-sm">
            <span className="text-gray-700">Service</span>
            <select
              className="mt-1 block w-full border border-gray-300 rounded-none px-2 py-1 text-sm"
              value={backend}
              onChange={e => setBackend(e.target.value)}>
              {CREDENTIAL_BACKENDS.map(b => <option key={b.key} value={b.key}>{b.label}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-gray-700">Label (optional)</span>
            <input
              className="mt-1 block w-full border border-gray-300 rounded-none px-2 py-1 text-sm"
              value={label}
              maxLength={100}
              onChange={e => setLabel(e.target.value)}
              placeholder="e.g. District item bank" />
          </label>
        </>
      )}
      <label className="block text-sm">
        <span className="text-gray-700">Key</span>
        <input
          className="mt-1 block w-full border border-gray-300 rounded-none px-2 py-1 text-sm font-mono"
          value={key}
          onChange={e => setKey(e.target.value)}
          autoComplete="off" />
      </label>
      <label className="block text-sm">
        <span className="text-gray-700">Secret</span>
        <input
          type="password"
          className="mt-1 block w-full border border-gray-300 rounded-none px-2 py-1 text-sm font-mono"
          value={secret}
          onChange={e => setSecret(e.target.value)}
          autoComplete="new-password" />
      </label>
      {rotating && (
        <p className="text-xs text-gray-500">
          Rotation replaces the secret for the same account, so the key must stay the same. A different account needs a new connection.
        </p>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          className="inline-flex items-center px-3 py-2 bg-gray-900 text-white border border-gray-900 rounded-none text-sm hover:bg-gray-700 disabled:opacity-50"
          onClick={save}
          disabled={busy}>
          {busy ? "Saving..." : form === "add" ? "Create connection" : "Rotate secret"}
        </button>
        <button
          type="button"
          className="inline-flex items-center px-3 py-2 bg-gray-100 border border-gray-300 rounded-none text-sm text-gray-700 hover:bg-gray-200"
          onClick={resetForm}>
          Cancel
        </button>
      </div>
    </div>
  );

  if (!user) return null;

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden grid grid-col-1">
      <p className="text-sm text-gray-500 mb-3">
        A connection lets your items use an external service without the credential ever reaching them.
        Every save of an item writes through the connection marked current for its language. Share it to let someone else use it without seeing the credential. The secret is sent once and never shown again.
      </p>
      {user?.uid && (
        <div className="flex items-center gap-2 text-sm text-gray-600 mb-3">
          <span>Your account ID</span>
          <CopyableId value={user.uid} title="Click to copy your account ID" />
          <span className="text-xs text-gray-400">Give it to someone who wants to share a connection with you.</span>
        </div>
      )}

      {status === "error" && !form && (
        <p className="text-sm text-red-600 mb-2">Connections are unavailable right now. {error}</p>
      )}

      {unchosen.map(cc => (
        <p key={cc.lang} className="text-sm text-gray-700 mb-2">Choose which connection L{cc.lang} saves go through.</p>
      ))}
      {uncovered.map(cc => (
        <p key={cc.lang} className="text-sm text-gray-500 mb-2">
          No {backendLabel(cc.backend)} connection for L{cc.lang} — previews only. Add one below to save items to {backendLabel(cc.backend)}.
        </p>
      ))}

      <ul className="space-y-2 mb-2">
        {connections.map(c => (
          rotating === c.connectionId ? <li key={c.connectionId}>{formView}</li> :
          c.shared ? (
            <li key={c.connectionId} className="flex items-center justify-between border border-gray-300 px-4 py-1 rounded-none">
              <div className="flex flex-col">
                {rowHeading(c)}
                <small className="text-sm text-neutral-500 font-light space-x-3">
                  <span>
                    {c.sharedBy ? (
                      <>Shared with you by <span className="text-neutral-700">{c.sharedBy.name}</span>
                        {c.sharedBy.name !== c.sharedBy.shortId && <> <span className="font-mono text-xs">{c.sharedBy.shortId}</span></>}</>
                    ) : "Shared with you"}
                  </span>
                  <span className="font-mono">{(c.permissions || []).map(p => `L${p.lang} ${p.fn}`).join(", ")}</span>
                  {c.expiresAt && <span>until {new Date(c.expiresAt).toLocaleDateString()}</span>}
                </small>
                {currentRadios(c)}
                {confirming === `leave:${c.connectionId}` && (
                  <span className="text-xs text-gray-700 mt-1">
                    Leave? You lose access until the owner shares it again.{" "}
                    <button type="button" className="underline" disabled={busy} onClick={() => act(() => leaveSharedConnection({ user, connectionId: c.connectionId }))}>Leave</button>{" "}
                    <button type="button" className="underline" onClick={() => setConfirming(null)}>Cancel</button>
                  </span>
                )}
              </div>
              <button type="button" className="text-sm text-gray-600 hover:text-gray-900 underline" onClick={() => setConfirming(`leave:${c.connectionId}`)}>
                Leave
              </button>
            </li>
          ) :
          <li key={c.connectionId}>
          <div className="flex items-center justify-between border border-gray-300 px-4 py-1 rounded-none">
            <div className="flex flex-col">
              {rowHeading(c)}
              {c.system && (
                <small className="text-xs text-gray-500 mt-1">
                  Graffiticode preview account — signs previews only; not used for saves.
                </small>
              )}
              {currentRadios(c)}
              {confirming === `disable:${c.connectionId}` && (
                <span className="text-xs text-gray-700 mt-1">
                  Disable? Every run and published view through it stops, and it cannot be re-enabled.{" "}
                  <button type="button" className="underline" disabled={busy} onClick={() => act(() => disableConnection({ user, connectionId: c.connectionId }))}>Disable</button>{" "}
                  <button type="button" className="underline" onClick={() => setConfirming(null)}>Cancel</button>
                </span>
              )}
              {confirming === `delete:${c.connectionId}` && (
                <span className="text-xs text-gray-700 mt-1">
                  Delete? The credential is erased, items using it stop working, and everyone it is shared with loses access.{" "}
                  <button type="button" className="underline text-red-700" disabled={busy} onClick={() => act(() => deleteConnection({ user, connectionId: c.connectionId }))}>Delete</button>{" "}
                  <button type="button" className="underline" onClick={() => setConfirming(null)}>Cancel</button>
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {c.status === "active" && (
                <>
                  {!c.system && <button type="button" title="Share" onClick={() => setSharing(sharing === c.connectionId ? null : c.connectionId)}>
                    <UserPlusIcon className="h-5 w-5 text-gray-500 hover:text-gray-800" />
                  </button>}
                  <button type="button" title="Rotate secret" onClick={() => { resetForm(); setForm(`rotate:${c.connectionId}`); }}>
                    <ArrowPathIcon className="h-5 w-5 text-gray-500 hover:text-gray-800" />
                  </button>
                  <button type="button" title="Disable" onClick={() => setConfirming(`disable:${c.connectionId}`)}>
                    <NoSymbolIcon className="h-5 w-5 text-gray-500 hover:text-gray-800" />
                  </button>
                </>
              )}
              <button type="button" title="Delete" onClick={() => setConfirming(`delete:${c.connectionId}`)}>
                <TrashIcon className="h-5 w-5 text-red-500 hover:text-red-700" />
              </button>
            </div>
          </div>
          {!c.system && (
            <ConnectionSharing
              user={user}
              connectionId={c.connectionId}
              ownerPermissions={c.ownerPermissions ?? null}
              showForm={sharing === c.connectionId && c.status === "active"}
              editable={c.status === "active"}
              onOwnerChanged={refresh} />
          )}
          </li>
        ))}
      </ul>

      {error && !form && status !== "error" && <p className="text-sm text-red-600 mb-2">{error}</p>}

      {form === "add" ? formView : (
        <div>
          <button
            type="button"
            className="inline-flex items-center px-3 py-2 bg-gray-100 border border-gray-300 rounded-none text-sm text-gray-700 hover:bg-gray-200"
            onClick={() => { resetForm(); setForm("add"); }}>
            <PlusIcon className="h-4 w-4 mr-1" />
            Add connection
          </button>
        </div>
      )}
    </div>
  );
}
