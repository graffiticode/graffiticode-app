import { useCallback, useEffect, useState, type ReactNode } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import UserSearchCombobox from "./UserSearchCombobox";
import {
  loadConnectionFunctions,
  loadConnectionGrants,
  revokeConnectionGrant,
  setOwnerPermissions,
  shareConnection,
  updateConnectionGrant,
  type AccountMatch,
} from "../utils/swr/fetchers";

// Plain descriptions of protected functions (share form, column tooltips); anything
// unlisted shows its name.
const FUNCTION_LABELS: Record<string, string> = {
  "init": "Render items (previews)",
  "save-to-itembank": "Write items to your item bank",
  "author": "Open items in the Author Site",
};

interface Permission { lang: string; fn: string }
interface Shareable extends Permission { kind: string }
// A protected function on the connection's backend (policy registry).
interface Fn extends Shareable { implicit: boolean; delegable: boolean }

interface Grant {
  grantId: string;
  recipient: string | null;
  pending: boolean;
  permissions: Permission[];
  expiresAt: string | null;
  createdAt: string;
}

interface Access {
  permissions: Permission[];
  expires: string; // yyyy-mm-dd, or "" for no end
}

const same = (a: Permission, b: Permission) => a.lang === b.lang && a.fn === b.fn;
const langLabel = (lang: string) => `L${lang}`;
const toDate = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
// An end date means the end of that day, in the owner's time zone.
const fromDate = (date: string) => (date ? new Date(`${date}T23:59:59`).toISOString() : null);
const accessVars = (a: Access) => ({ permissions: a.permissions, expiresAt: fromDate(a.expires) });

const looksLikeEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

// Who a new share goes to: an account picked from the lookup, or (when an
// email finds no account) the email itself, pending until they link it.
type Recipient = { kind: "account"; match: AccountMatch } | { kind: "email"; email: string };

const errorText = (err: any) =>
  String(err?.response?.errors?.[0]?.message || err?.message || err).replace(/^Connection request refused: /, "Refused: ");

// Chooses the exact functions a grant allows, grouped by language.
function FunctionPicker({ access, onChange, shareable }: { access: Access; onChange: (a: Access) => void; shareable: Shareable[] }) {
  const toggle = (p: Permission) => onChange({
    ...access,
    permissions: access.permissions.some(q => same(p, q))
      ? access.permissions.filter(q => !same(p, q))
      : [...access.permissions, { lang: p.lang, fn: p.fn }],
  });
  const langs = [...new Set(shareable.map(s => s.lang))];
  return (
    <div className="basis-full space-y-2">
      {langs.map(lang => (
        <fieldset key={lang} className="text-sm">
          <legend className="text-xs font-semibold text-gray-600">{langLabel(lang)}</legend>
          {shareable.filter(s => s.lang === lang).map(s => (
            <label key={s.fn} className="flex items-center gap-2">
              <input type="checkbox" checked={access.permissions.some(q => same(s, q))} onChange={() => toggle(s)} />
              <span>{FUNCTION_LABELS[s.fn] || s.fn}</span>
              <span className="font-mono text-xs text-gray-400">{s.fn}</span>
            </label>
          ))}
        </fieldset>
      ))}
    </div>
  );
}

const writes = (access: Access, shareable: Shareable[]) =>
  access.permissions.some(p => shareable.find(s => same(s, p))?.kind === "write");

const blank: Access = { permissions: [], expires: "" };
const accessOf = (g: Grant): Access => ({ permissions: g.permissions, expires: toDate(g.expiresAt) });
const samePermissions = (a: Permission[], b: Permission[]) =>
  a.length === b.length && a.every(p => b.some(q => same(p, q)));
const sameAccess = (a: Access, b: Access) => a.expires === b.expires && samePermissions(a.permissions, b.permissions);
// Columns: by language, the implicit function (rendering) first, then the
// ones that can be shared, then the owner's alone.
const columnOrder = (a: Fn, b: Fn) =>
  a.lang.localeCompare(b.lang) ||
  Number(b.implicit) - Number(a.implicit) ||
  Number(b.delegable) - Number(a.delegable) ||
  a.fn.localeCompare(b.fn);

// Who may use one owned connection, and for what: a table beneath its row
// with one row per protected function its languages register for the
// connection's backend (grouped by language) and one column per account. The
// owner's column comes first and covers every function, author included;
// everything (no list) is how every connection starts, and its first edit
// turns it into the explicit list. Each sharee's column covers only the
// functions that can be shared. A language's implicit
// function (rendering) comes with any other function checked in it, and can
// be checked alone for previews only. Columns edit in place with Save/Cancel;
// changes take effect at that account's next run or view. The find-and-share
// form (`showForm`, toggled by the row's Share button) adds a column.
export default function ConnectionSharing({ user, connectionId, ownerPermissions, showForm, editable = true, onOwnerChanged }: {
  user: any;
  connectionId: string;
  // What the owner allows themselves; null is everything.
  ownerPermissions: Permission[] | null;
  showForm: boolean;
  editable?: boolean;
  // After the owner's own access changes (current-connection candidates follow it).
  onOwnerChanged?: () => Promise<unknown> | void;
}) {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [fns, setFns] = useState<Fn[] | null>(null);
  // The typed text and its settled matches (null: not searched yet), for the
  // share-by-email fallback when a complete email finds no account.
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<AccountMatch[] | null>(null);
  // Bumped after a share to clear the typeahead.
  const [searchKey, setSearchKey] = useState(0);
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [access, setAccess] = useState<Access>(blank);
  // Unsaved edits: the owner's list (undefined: unchanged; null: everything),
  // and each sharee's access by grant.
  const [ownerDraft, setOwnerDraft] = useState<Permission[] | null | undefined>(undefined);
  const [drafts, setDrafts] = useState<Record<string, Access>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setGrants(await loadConnectionGrants({ user, connectionId }));
    } catch (err) {
      setMessage(errorText(err));
      setGrants([]);
    }
  }, [user, connectionId]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    loadConnectionFunctions({ user, connectionId })
      .then((list: Fn[]) => setFns([...list].sort(columnOrder)))
      .catch(() => setFns([]));
  }, [user, connectionId]);
  const columns = fns || [];
  const shareable = columns.filter(f => f.delegable);
  const langs = [...new Set(columns.map(f => f.lang))];

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      if (done) setMessage(done);
      await refresh();
      return true;
    } catch (err) {
      setMessage(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onResults = useCallback((q: string, found: AccountMatch[] | null) => {
    setQuery(q);
    setMatches(found);
    // A share-by-email choice belongs to the text it was made for.
    setRecipient(r => (r?.kind === "email" && r.email !== q ? null : r));
  }, []);

  const share = async () => {
    if (!recipient) return;
    const ok = await run(
      () => shareConnection({
        user,
        connectionId,
        ...(recipient.kind === "account" ? { accountId: recipient.match.accountId } : { email: recipient.email }),
        ...accessVars(access),
      }),
      recipient.kind === "account"
        ? `Shared with ${recipient.match.name} (${recipient.match.shortId}).`
        : `Shared with ${recipient.email}. It applies when they link this email to their account.`);
    if (ok) {
      setQuery("");
      setMatches(null);
      setRecipient(null);
      setAccess(blank);
      setSearchKey(k => k + 1);
    }
  };

  const saveGrant = async (g: Grant) => {
    const draft = drafts[g.grantId];
    if (!draft) return;
    if (await run(() => updateConnectionGrant({ user, connectionId, grantId: g.grantId, ...accessVars(draft) }))) {
      setDrafts(({ [g.grantId]: _saved, ...rest }) => rest);
    }
  };
  const saveOwner = async () => {
    if (ownerDraft === undefined) return;
    const ok = await run(async () => {
      await setOwnerPermissions({ user, connectionId, permissions: ownerDraft });
      await onOwnerChanged?.();
    });
    if (ok) setOwnerDraft(undefined);
  };

  const incomplete = (a: Access) => a.permissions.length === 0;

  // One cell: checked when the list names the function, or (for rendering)
  // when it names anything else in that language, which brings it along.
  const cell = (key: string, list: Permission[] | null, f: Fn, onToggle: ((p: Permission) => void) | null) => {
    const named = list === null || list.some(p => same(p, f));
    const implied = !named && list !== null && f.implicit && list.some(p => p.lang === f.lang);
    return (
      <td key={key} className="px-3 py-1 text-center">
        <input
          type="checkbox"
          aria-label={`${langLabel(f.lang)} ${f.fn}`}
          title={implied ? `Comes with any other ${langLabel(f.lang)} access` : `${langLabel(f.lang)} ${f.fn}`}
          checked={named || implied}
          disabled={busy || !onToggle || implied}
          onChange={() => onToggle?.(f)} />
      </td>
    );
  };
  const notShareable = (key: string) => (
    <td key={key} className="px-3 py-1 text-center text-gray-300" title="Only you can use this; it is never shared">—</td>
  );
  // Everything (null) as the explicit list it stands for, when it's edited.
  const allPermissions = () => columns.map(f => ({ lang: f.lang, fn: f.fn }));
  const toggled = (list: Permission[], p: Permission) =>
    list.some(q => same(p, q)) ? list.filter(q => !same(p, q)) : [...list, { lang: p.lang, fn: p.fn }];
  const saveButtons = (dirty: boolean, onSave: () => void, onCancel: () => void, saveDisabled = false) => dirty && (
    <span className="flex items-center justify-center gap-2">
      <button
        type="button"
        className="px-2 py-0.5 bg-gray-900 text-white border border-gray-900 rounded-none text-xs hover:bg-gray-700 disabled:opacity-50"
        onClick={onSave}
        disabled={busy || saveDisabled}>
        Save
      </button>
      <button type="button" className="text-xs text-gray-600 underline" onClick={onCancel}>Cancel</button>
    </span>
  );

  // One column per account: what it may use, its end date, and its Save/Cancel
  // (and remove, for a sharee).
  type Column = {
    key: string;
    header: ReactNode;
    list: Permission[] | null;
    onToggle: ((p: Permission) => void) | null;
    // A sharee's column covers only the functions that can be shared.
    shareableOnly: boolean;
    until: ReactNode;
    actions: ReactNode;
  };

  const ownerList = ownerDraft === undefined ? ownerPermissions : ownerDraft;
  const ownerDirty = ownerDraft !== undefined &&
    !(ownerDraft === null ? ownerPermissions === null : ownerPermissions !== null && samePermissions(ownerDraft, ownerPermissions));
  const ownerColumn: Column = {
    key: "owner",
    header: <span className="font-medium text-gray-900">You</span>,
    list: ownerList,
    onToggle: editable ? p => setOwnerDraft(toggled(ownerList ?? allPermissions(), p)) : null,
    shareableOnly: false,
    until: <span className="text-gray-400">—</span>,
    actions: saveButtons(ownerDirty, saveOwner, () => setOwnerDraft(undefined)),
  };

  const shareeColumn = (g: Grant): Column => {
    const draft = drafts[g.grantId] || accessOf(g);
    const dirty = !sameAccess(draft, accessOf(g));
    const edit = (a: Access) => setDrafts(d => ({ ...d, [g.grantId]: a }));
    const cancel = () => setDrafts(({ [g.grantId]: _dropped, ...rest }) => rest);
    return {
      key: g.grantId,
      // Pending and claimed shares look the same here.
      header: (
        <span className="inline-flex items-center gap-1">
          <span className="font-mono font-normal text-gray-900">{g.recipient || "someone"}</span>
          {editable && (
            <button type="button" title="Remove access" disabled={busy} onClick={() => run(() => revokeConnectionGrant({ user, connectionId, grantId: g.grantId }))}>
              <XMarkIcon className="h-4 w-4 text-gray-500 hover:text-red-700" />
            </button>
          )}
        </span>
      ),
      list: draft.permissions,
      onToggle: editable ? p => edit({ ...draft, permissions: toggled(draft.permissions, p) }) : null,
      shareableOnly: true,
      until: editable ? (
        <input
          type="date"
          aria-label="Until"
          className="border border-gray-300 rounded-none px-1 py-0.5 text-xs"
          value={draft.expires}
          onChange={e => edit({ ...draft, expires: e.target.value })} />
      ) : g.expiresAt ? new Date(g.expiresAt).toLocaleDateString() : <span className="text-gray-400">—</span>,
      actions: saveButtons(dirty, () => saveGrant(g), cancel, incomplete(draft)),
    };
  };

  const accounts = [ownerColumn, ...(grants || []).map(shareeColumn)];

  const anyActions = accounts.some(c => c.actions);

  // Permissions are rows, grouped by language; accounts are columns, the
  // owner first.
  const table = fns === null ? (
    <p className="text-xs text-gray-400">Loading access…</p>
  ) : (
    <div className="overflow-x-auto">
      <table className="text-sm">
        <thead>
          <tr className="text-sm">
            <th className="px-2 text-left text-xs font-normal text-gray-500">Permission</th>
            {accounts.map(c => <th key={c.key} className="px-3 pb-1 align-bottom">{c.header}</th>)}
          </tr>
        </thead>
        <tbody>
          {langs.map(lang => [
            <tr key={`lang:${lang}`} className="border-t border-gray-200">
              <th colSpan={1 + accounts.length} className="px-2 pt-1 text-left text-xs font-semibold text-gray-600">{langLabel(lang)}</th>
            </tr>,
            ...columns.filter(f => f.lang === lang).map(f => (
              <tr key={`${f.lang}:${f.fn}`}>
                <th scope="row" className="px-2 py-1 text-left font-mono font-normal" title={FUNCTION_LABELS[f.fn] || f.fn}>{f.fn}</th>
                {accounts.map(c => (c.shareableOnly && !f.delegable
                  ? notShareable(c.key)
                  : cell(c.key, c.list, f, c.onToggle)))}
              </tr>
            )),
          ])}
          <tr className="border-t border-gray-200">
            <th scope="row" className="px-2 py-1 text-left text-xs font-normal text-gray-500">Until</th>
            {accounts.map(c => <td key={c.key} className="px-3 py-1 text-center">{c.until}</td>)}
          </tr>
          {anyActions && (
            <tr>
              <th />
              {accounts.map(c => <td key={c.key} className="px-3 py-1">{c.actions}</td>)}
            </tr>
          )}
        </tbody>
      </table>
      {grants === null && <p className="text-xs text-gray-400 mt-1">Loading sharees…</p>}
      {ownerList !== null && ownerList.length === 0 && (
        <p className="text-xs text-gray-700 mt-1">With nothing checked, you can&apos;t use this connection yourself. People you share it with still can.</p>
      )}
    </div>
  );

  // Finding an account and sharing with it, beneath the table.
  const findAndShare = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="block text-sm flex-1 min-w-[12rem]">
          <span className="text-gray-700">Find an account (name, email or account ID)</span>
          <div className="mt-1">
            <UserSearchCombobox
              key={searchKey}
              selectedUser={recipient?.kind === "account" ? recipient.match : null}
              onSelectUser={m => setRecipient(m ? { kind: "account", match: m } : null)}
              onResults={onResults}
              placeholder="Start typing a name, email or account ID" />
          </div>
        </div>
        <DateField value={access.expires} onChange={expires => setAccess({ ...access, expires })} />
        <button
          type="button"
          className="inline-flex items-center px-3 py-1.5 bg-gray-900 text-white border border-gray-900 rounded-none text-sm hover:bg-gray-700 disabled:opacity-50"
          onClick={share}
          disabled={busy || !recipient || incomplete(access)}>
          Share
        </button>
        {recipient?.kind === "account" && (
          <p className="basis-full text-sm">
            Sharing with <span className="font-medium">{recipient.match.name}</span>{" "}
            <span className="font-mono text-xs text-gray-500">{recipient.match.shortId}</span>
          </p>
        )}
        {recipient?.kind !== "account" && matches?.length === 0 && looksLikeEmail(query) && (
          <label className="basis-full flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={recipient?.kind === "email"}
              onChange={e => setRecipient(e.target.checked ? { kind: "email", email: query } : null)} />
            <span>No account has linked this email. Share with this email anyway — it applies when they link it.</span>
          </label>
        )}
        <FunctionPicker access={access} onChange={setAccess} shareable={shareable} />
      </div>
      <p className="text-xs text-gray-500">
        Any function checked also lets them render items in that language. They never see your key or secret, cannot share it onward, and cannot publish. Opening the Author Site is never shared.
        {writes(access, shareable) && " Writing lets them write any item into your item bank."}
      </p>
    </div>
  );

  return (
    <div className="border border-gray-300 border-t-0 px-4 py-2 space-y-3 rounded-none">
      <div>
        <p className="text-xs font-semibold text-gray-600 mb-1">Access</p>
        {table}
      </div>
      {showForm && editable && findAndShare}
      {message && <p className="text-xs text-gray-700">{message}</p>}
    </div>
  );
}

function DateField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="block text-sm">
      <span className="text-gray-700">Until (optional)</span>
      <input
        type="date"
        className="mt-1 block border border-gray-300 rounded-none px-2 py-1 text-sm"
        value={value}
        onChange={e => onChange(e.target.value)} />
    </label>
  );
}
