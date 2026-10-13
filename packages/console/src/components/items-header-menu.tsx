import { useEffect, useRef, useState } from 'react';
import { AdjustmentsHorizontalIcon } from '@heroicons/react/24/outline';
import MarkSelector from './mark-selector';
import ClientSelector, { ClientOption } from './client-selector';

export type SortField = 'updated' | 'created' | 'name';
export type SortDirection = 'asc' | 'desc';
export interface Sort {
  field: SortField;
  direction: SortDirection;
}

export interface DateFilter {
  field: 'updated' | 'created';
  from: number | null;
  to: number | null;
}

export const DEFAULT_SORT: Sort = { field: 'created', direction: 'desc' };
export const DEFAULT_DATE_FILTER: DateFilter = { field: 'updated', from: null, to: null };

const SORT_OPTIONS: { label: string; sort: Sort }[] = [
  { label: 'Created ↓', sort: { field: 'created', direction: 'desc' } },
  { label: 'Created ↑', sort: { field: 'created', direction: 'asc' } },
  { label: 'Updated ↓', sort: { field: 'updated', direction: 'desc' } },
  { label: 'Updated ↑', sort: { field: 'updated', direction: 'asc' } },
  { label: 'Name A→Z', sort: { field: 'name', direction: 'asc' } },
  { label: 'Name Z→A', sort: { field: 'name', direction: 'desc' } },
];

function isDefaultSort(sort: Sort) {
  return sort.field === DEFAULT_SORT.field && sort.direction === DEFAULT_SORT.direction;
}

function isDefaultDateFilter(df: DateFilter) {
  return df.from === null && df.to === null;
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
  mark: any;
  setMark: (m: any) => void;
  client: ClientOption;
  setClient: (c: ClientOption) => void;
  clientList?: ClientOption[];
  sort: Sort;
  setSort: (s: Sort) => void;
  dateFilter: DateFilter;
  setDateFilter: (d: DateFilter) => void;
}

export default function ItemsHeaderMenu({
  mark,
  setMark,
  client,
  setClient,
  clientList,
  sort,
  setSort,
  dateFilter,
  setDateFilter,
}: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: -9999, left: -9999 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const showBadge = !isDefaultSort(sort) || !isDefaultDateFilter(dateFilter);

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

  const handleReset = () => {
    setSort(DEFAULT_SORT);
    setDateFilter(DEFAULT_DATE_FILTER);
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
        aria-label="Sort and filter items"
        title="Sort and filter"
      >
        <AdjustmentsHorizontalIcon className="h-4 w-4" aria-hidden="true" />
        {showBadge && (
          <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-blue-500" aria-hidden="true" />
        )}
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 z-50"
          onClick={() => setIsOpen(false)}
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
                <div className="text-xs font-semibold text-gray-700 mb-2">Sort</div>
                <div className="grid grid-cols-2 gap-1">
                  {SORT_OPTIONS.map((opt) => {
                    const selected =
                      sort.field === opt.sort.field && sort.direction === opt.sort.direction;
                    return (
                      <button
                        key={`${opt.sort.field}-${opt.sort.direction}`}
                        type="button"
                        onClick={() => setSort(opt.sort)}
                        className={`text-xs text-left px-2 py-1.5 ring-1 ${
                          selected
                            ? 'ring-gray-700 bg-gray-100 text-gray-900'
                            : 'ring-gray-300 text-gray-700 hover:bg-gray-50'
                        } rounded-none`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="border-t pt-4">
                <div className="text-xs font-semibold text-gray-700 mb-2">Filter</div>

                <div className="flex items-center gap-3 mb-3">
                  <label className="block text-xs text-gray-600 w-12">Mark</label>
                  <MarkSelector mark={mark} setMark={setMark} />
                </div>

                <div className="flex items-center gap-3 mb-3">
                  <label className="block text-xs text-gray-600 w-12">Client</label>
                  <ClientSelector client={client} setClient={setClient} clientList={clientList} />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs text-gray-600">Date range</label>
                    <div className="inline-flex ring-1 ring-gray-300 rounded-none">
                      {(['updated', 'created'] as const).map((field) => (
                        <button
                          key={field}
                          type="button"
                          onClick={() => setDateFilter({ ...dateFilter, field })}
                          className={`text-xs px-2 py-0.5 ${
                            dateFilter.field === field
                              ? 'bg-gray-700 text-white'
                              : 'text-gray-700 hover:bg-gray-100'
                          }`}
                        >
                          {field === 'updated' ? 'Updated' : 'Created'}
                        </button>
                      ))}
                    </div>
                  </div>
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
                  {!isDefaultDateFilter(dateFilter) && (
                    <button
                      type="button"
                      onClick={() =>
                        setDateFilter({ ...dateFilter, from: null, to: null })
                      }
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
                  Reset sort &amp; dates
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
