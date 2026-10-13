import { useState, useEffect, useRef } from 'react';
import { Combobox } from '@headlessui/react';
import { CheckIcon } from '@heroicons/react/20/solid';
import useGraffiticodeAuth from '@graffiticode/auth-react';
import { findAccounts, type AccountMatch } from '../utils/swr/fetchers';

function classNames(...classes: string[]) {
  return classes.filter(Boolean).join(' ');
}

const MIN_QUERY = 2;
const DEBOUNCE_MS = 250;

const MATCHED_BY: Record<AccountMatch['matchedBy'], string> = {
  email: 'matched by email',
  name: 'matched by name',
  id: 'matched by account ID',
};

interface UserSearchComboboxProps {
  selectedUser: AccountMatch | null;
  onSelectUser: (user: AccountMatch | null) => void;
  placeholder?: string;
  // Told the trimmed query and its matches once a search settles (null while
  // the query is too short, searching, or the search failed).
  onResults?: (query: string, matches: AccountMatch[] | null) => void;
}

// A typeahead over accounts: as the user types (2+ characters, debounced),
// the server's findAccounts lists every account whose profile name, linked
// email or account ID contains the text. Rows show the name, short ID and
// what matched — never an email.
export default function UserSearchCombobox({
  selectedUser,
  onSelectUser,
  placeholder = "Name, email or account ID",
  onResults,
}: UserSearchComboboxProps) {
  const { user } = useGraffiticodeAuth();
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<AccountMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // The auth user object can change identity between renders; look up with
  // the latest one but re-run only when the signed-in account changes.
  const userRef = useRef(user);
  userRef.current = user;
  const uid = user?.uid;
  const onResultsRef = useRef(onResults);
  onResultsRef.current = onResults;

  // Handle click outside to close dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // Look up the typed query, debounced; a newer query discards older answers.
  useEffect(() => {
    const q = query.trim();
    setError(null);
    onResultsRef.current?.(q, null);
    if (q.length < MIN_QUERY || !uid) {
      setMatches([]);
      setLoading(false);
      return;
    }
    let stale = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const found = await findAccounts({ user: userRef.current, query: q });
        if (!stale) {
          setMatches(found);
          onResultsRef.current?.(q, found);
        }
      } catch {
        if (!stale) {
          setMatches([]);
          setError('Search is unavailable right now.');
        }
      } finally {
        if (!stale) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query, uid]);

  const displayValue = (match: AccountMatch | null) =>
    match ? `${match.name} (${match.shortId})` : '';

  const status = query.trim().length < MIN_QUERY
    ? `Type at least ${MIN_QUERY} characters of a name, email or account ID.`
    : loading
      ? 'Searching…'
      : error || (matches.length === 0 ? 'No matches' : null);

  return (
    <Combobox as="div" value={selectedUser} by="accountId" onChange={(match: AccountMatch | null) => {
      onSelectUser(match);
      setIsOpen(false);
    }}>
      <div className="relative" ref={containerRef}>
        <Combobox.Input
          className="w-full rounded-none border border-gray-300 bg-white py-2 pl-3 pr-3 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500 sm:text-sm"
          onChange={(event) => {
            setQuery(event.target.value);
            setIsOpen(true);
            // Editing the text drops an earlier pick.
            if (selectedUser) onSelectUser(null);
          }}
          onFocus={() => setIsOpen(true)}
          displayValue={displayValue}
          placeholder={placeholder}
        />

        {isOpen && (
          <Combobox.Options static className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-none bg-white py-1 text-base shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none sm:text-sm">
          {status ? (
            <div className="relative cursor-default select-none py-2 px-4 text-gray-700">
              {status}
            </div>
          ) : (
            matches.map((match) => (
              <Combobox.Option
                key={match.accountId}
                value={match}
                onClick={() => {
                  setTimeout(() => setIsOpen(false), 0);
                }}
                className={({ active }) =>
                  classNames(
                    'relative cursor-default select-none py-2 pl-8 pr-4',
                    active ? 'bg-gray-100 text-gray-900' : 'text-gray-900'
                  )
                }
              >
                {({ selected }) => (
                  <>
                    <div className="flex flex-col">
                      <span className={classNames('block truncate', selected ? 'font-semibold' : 'font-normal')}>
                        {match.name}
                      </span>
                      <span className="block truncate text-xs text-gray-500">
                        {match.shortId} · {MATCHED_BY[match.matchedBy]}
                      </span>
                    </div>
                    {selected && (
                      <span className="absolute inset-y-0 left-0 flex items-center pl-1.5 text-gray-600">
                        <CheckIcon className="h-5 w-5" aria-hidden="true" />
                      </span>
                    )}
                  </>
                )}
              </Combobox.Option>
            ))
          )}
        </Combobox.Options>
        )}
      </div>
    </Combobox>
  );
}
