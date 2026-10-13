import { useEffect, useRef, useState } from 'react';
import { AdjustmentsHorizontalIcon } from '@heroicons/react/24/outline';
import ClientSelector, { ClientOption, ALL_CLIENT } from './client-selector';

export interface TasksDateFilter {
  from: number | null;
  to: number | null;
}

export interface TasksLangFilter {
  sequence: string;
}

export const DEFAULT_TASKS_DATE_FILTER: TasksDateFilter = { from: null, to: null };
export const DEFAULT_TASKS_LANG_FILTER: TasksLangFilter = { sequence: '' };
export const DEFAULT_TASKS_ITEM_FILTER = '';

export function isDefaultTasksDateFilter(df: TasksDateFilter) {
  return df.from === null && df.to === null;
}

export function isDefaultTasksLangFilter(lf: TasksLangFilter) {
  return !lf.sequence.trim();
}

// Item ids are Firestore auto-ids (20 chars). Anything shorter is treated as a
// prefix and matched client-side; a full id is pushed down to the query.
export const ITEM_ID_LENGTH = 20;

export function isFullItemId(value: string) {
  return value.trim().length >= ITEM_ID_LENGTH;
}

export function matchesItemFilter(itemId: string, filter: string): boolean {
  const f = filter.trim();
  if (!f) return true;
  return typeof itemId === 'string' && itemId.startsWith(f);
}

// Pattern semantics (chain = task langs joined by '+'):
//   '+' on a side means "1 or more segments" on that side.
//   '*' on a side means "0 or more segments" on that side.
//   No marker means "no segments" on that side (anchored to chain boundary).
// So the matcher is a Cartesian product of (left, right) ∈ {none, '+', '*'}:
//   nnnn     — atomic
//   nnnn+    — head (followed by 1+)
//   nnnn*    — atomic or head (followed by 0+)
//   +nnnn    — tail (preceded by 1+)
//   *nnnn    — atomic or tail (preceded by 0+)
//   +nnnn+   — middle only
//   +nnnn*   — tail or middle
//   *nnnn+   — head or middle
//   *nnnn*   — anywhere (only pattern that matches all positions)
// Multi-segment patterns (e.g. +0166+0001+) work the same way — the inner
// part can be any chain fragment; only the outermost markers anchor.
export function matchesLangPattern(taskLangs: string[] | null, pattern: string): boolean {
  const p = pattern.trim();
  if (!p) return true;
  if (!Array.isArray(taskLangs) || taskLangs.length === 0) return false;
  const chain = taskLangs.join('+');

  type SideMode = 'none' | 'plus' | 'star';
  let s = p;
  let leftMode: SideMode = 'none';
  if (s.startsWith('*')) { leftMode = 'star'; s = s.slice(1); }
  else if (s.startsWith('+')) { leftMode = 'plus'; s = s.slice(1); }

  let rightMode: SideMode = 'none';
  if (s.length > 0 && s.endsWith('*')) { rightMode = 'star'; s = s.slice(0, -1); }
  else if (s.length > 0 && s.endsWith('+')) { rightMode = 'plus'; s = s.slice(0, -1); }

  if (!s) {
    // Pattern was just markers; only a lone '*' (zero or more) matches anything.
    return leftMode === 'star' || rightMode === 'star';
  }
  const inner = s;

  const isAtomic = chain === inner;
  const isHead = chain.startsWith(inner + '+');
  const isTail = chain.endsWith('+' + inner);
  const isMiddle = chain.includes('+' + inner + '+');

  const leftAllowsZero = leftMode === 'none' || leftMode === 'star';
  const leftAllowsOnePlus = leftMode === 'plus' || leftMode === 'star';
  const rightAllowsZero = rightMode === 'none' || rightMode === 'star';
  const rightAllowsOnePlus = rightMode === 'plus' || rightMode === 'star';

  return (
    (leftAllowsZero && rightAllowsZero && isAtomic) ||
    (leftAllowsZero && rightAllowsOnePlus && isHead) ||
    (leftAllowsOnePlus && rightAllowsZero && isTail) ||
    (leftAllowsOnePlus && rightAllowsOnePlus && isMiddle)
  );
}

function epochToDateInput(ms: number | null): string {
  if (!ms) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dateInputToEpoch(value: string, endOfDay: boolean): number | null {
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return null;
  const date = endOfDay
    ? new Date(y, m - 1, d, 23, 59, 59, 999)
    : new Date(y, m - 1, d, 0, 0, 0, 0);
  return date.getTime();
}

interface Props {
  dateFilter: TasksDateFilter;
  setDateFilter: (d: TasksDateFilter) => void;
  langFilter: TasksLangFilter;
  setLangFilter: (l: TasksLangFilter) => void;
  itemFilter: string;
  setItemFilter: (v: string) => void;
  client: ClientOption;
  setClient: (c: ClientOption) => void;
  clientList?: ClientOption[];
}

export default function TasksHeaderMenu({
  dateFilter,
  setDateFilter,
  langFilter,
  setLangFilter,
  itemFilter,
  setItemFilter,
  client,
  setClient,
  clientList,
}: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: -9999, left: -9999 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [seqDraft, setSeqDraft] = useState(langFilter.sequence);
  const [itemDraft, setItemDraft] = useState(itemFilter);

  useEffect(() => {
    setSeqDraft(langFilter.sequence);
  }, [langFilter.sequence]);

  useEffect(() => {
    setItemDraft(itemFilter);
  }, [itemFilter]);

  const showBadge =
    !isDefaultTasksDateFilter(dateFilter) ||
    !isDefaultTasksLangFilter(langFilter) ||
    itemFilter.trim() !== '' ||
    client.id !== ALL_CLIENT.id;

  const positionMenu = () => {
    if (!buttonRef.current || !panelRef.current) return;
    const btn = buttonRef.current.getBoundingClientRect();
    const panelW = panelRef.current.offsetWidth || 320;
    const panelH = panelRef.current.offsetHeight;
    let top = btn.bottom + 4;
    if (top + panelH > window.innerHeight - 10) {
      top = Math.max(10, window.innerHeight - panelH - 10);
    }
    let left = btn.left;
    if (left + panelW > window.innerWidth - 10) {
      left = Math.max(10, window.innerWidth - panelW - 10);
    }
    setPos({ top, left });
  };

  useEffect(() => {
    if (!isOpen) {
      setPos({ top: -9999, left: -9999 });
      return;
    }
    setTimeout(() => {
      positionMenu();
      setTimeout(positionMenu, 50);
    }, 0);
    window.addEventListener('resize', positionMenu);
    return () => window.removeEventListener('resize', positionMenu);
  }, [isOpen]);

  const commitSeq = () => {
    const trimmed = seqDraft.trim();
    if (trimmed !== langFilter.sequence) {
      setLangFilter({ sequence: trimmed });
    }
  };

  const commitItem = () => {
    const trimmed = itemDraft.trim();
    if (trimmed !== itemFilter) {
      setItemFilter(trimmed);
    }
  };

  const commitDrafts = () => {
    commitSeq();
    commitItem();
  };

  const handleReset = () => {
    setDateFilter(DEFAULT_TASKS_DATE_FILTER);
    setLangFilter(DEFAULT_TASKS_LANG_FILTER);
    setItemFilter(DEFAULT_TASKS_ITEM_FILTER);
    setClient(ALL_CLIENT);
    setSeqDraft('');
    setItemDraft('');
  };

  return (
    <div className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen(o => !o);
        }}
        className="relative flex items-center text-gray-400 hover:text-gray-600 focus:outline-none"
        aria-label="Filter tasks"
        title="Filter"
      >
        <AdjustmentsHorizontalIcon className="h-4 w-4" aria-hidden="true" />
        {showBadge && (
          <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-blue-500" aria-hidden="true" />
        )}
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 z-50"
          onClick={() => { commitDrafts(); setIsOpen(false); }}
        >
          <div
            ref={panelRef}
            className="fixed bg-white shadow-lg ring-1 ring-gray-200 z-50 rounded-none"
            onClick={e => e.stopPropagation()}
            style={{
              width: '320px',
              top: `${pos.top}px`,
              left: `${pos.left}px`,
              maxHeight: 'calc(100vh - 40px)',
              overflow: 'auto',
            }}
          >
            <div className="p-4 space-y-4">
              <div>
                <div className="text-xs font-semibold text-gray-700 mb-2">Filter</div>

                <div className="flex items-center gap-3 mb-3">
                  <label className="block text-xs text-gray-600 w-12">Client</label>
                  <ClientSelector client={client} setClient={setClient} clientList={clientList} />
                </div>

                <div className="mb-3">
                  <label className="block text-xs text-gray-600 mb-1">Item</label>
                  <input
                    type="text"
                    spellCheck={false}
                    placeholder="item id or prefix"
                    value={itemDraft}
                    onChange={(e) => setItemDraft(e.target.value)}
                    onBlur={commitItem}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitItem();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setItemDraft(itemFilter);
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                    className="w-full text-xs font-mono ring-1 ring-gray-300 px-2 py-1.5 rounded-none focus:outline-none focus:ring-gray-500"
                  />
                  <p className="mt-1 text-[10px] text-gray-500 leading-tight">
                    Show every version of one item. Copy an id from a task&apos;s menu.
                  </p>
                </div>

                <div className="mb-3">
                  <label className="block text-xs text-gray-600 mb-1">Lang</label>
                  <input
                    type="text"
                    spellCheck={false}
                    placeholder="e.g. 0166, +0166, +0166+, *0166"
                    value={seqDraft}
                    onChange={(e) => setSeqDraft(e.target.value)}
                    onBlur={commitSeq}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitSeq();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setSeqDraft(langFilter.sequence);
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                    className="w-full text-xs font-mono ring-1 ring-gray-300 px-2 py-1.5 rounded-none focus:outline-none focus:ring-gray-500"
                  />
                  <p className="mt-1 text-[10px] text-gray-500 leading-tight">
                    <span className="font-mono">+</span> = 1+ segments,&nbsp;
                    <span className="font-mono">*</span> = 0+ segments.&nbsp;
                    Examples: <span className="font-mono">nnnn</span> atomic,&nbsp;
                    <span className="font-mono">nnnn+</span> head,&nbsp;
                    <span className="font-mono">+nnnn</span> tail,&nbsp;
                    <span className="font-mono">+nnnn+</span> middle,&nbsp;
                    <span className="font-mono">*nnnn*</span> anywhere.
                  </p>
                </div>

                <div>
                  <label className="block text-xs text-gray-600 mb-1">Created (date range)</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="date"
                      value={epochToDateInput(dateFilter.from)}
                      onChange={(e) =>
                        setDateFilter({
                          ...dateFilter,
                          from: dateInputToEpoch(e.target.value, false),
                        })
                      }
                      className="flex-1 min-w-0 text-xs ring-1 ring-gray-300 px-2 py-1 rounded-none focus:outline-none focus:ring-gray-500"
                    />
                    <span className="text-xs text-gray-500">to</span>
                    <input
                      type="date"
                      value={epochToDateInput(dateFilter.to)}
                      onChange={(e) =>
                        setDateFilter({
                          ...dateFilter,
                          to: dateInputToEpoch(e.target.value, true),
                        })
                      }
                      className="flex-1 min-w-0 text-xs ring-1 ring-gray-300 px-2 py-1 rounded-none focus:outline-none focus:ring-gray-500"
                    />
                  </div>
                  {!isDefaultTasksDateFilter(dateFilter) && (
                    <button
                      type="button"
                      onClick={() => setDateFilter({ from: null, to: null })}
                      className="mt-1 text-xs text-gray-500 hover:text-gray-700 underline"
                    >
                      Clear dates
                    </button>
                  )}
                </div>
              </div>

              <div className="border-t pt-3 flex justify-end">
                <button
                  type="button"
                  onClick={handleReset}
                  className="text-xs text-gray-600 hover:text-gray-900 px-2 py-1"
                >
                  Reset filters
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
