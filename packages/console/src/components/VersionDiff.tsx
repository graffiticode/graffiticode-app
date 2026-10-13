// The expanded body of a transcript row: what this version changed, as a
// unified diff of the changed regions only.
//
// The sources are already in the browser — useVersionSrc holds every version's
// text — so expanding costs no fetch, and cachedDiff means it costs no recompute
// after the first open.

import React, { useMemo } from 'react';
import { cachedDiff, collapseContext } from '../utils/lineDiff';

const ROW_STYLES = {
  add: 'bg-green-50 text-green-800',
  del: 'bg-red-50 text-red-800',
  ctx: 'text-gray-500',
};

const MARKERS = { add: '+', del: '−', ctx: ' ' };

export function VersionDiff({ diffKey, before, after }: {
  diffKey: string;
  before: string;
  after: string;
}) {
  const rows = useMemo(() => {
    const diff = cachedDiff(diffKey, before, after);
    return diff.tooLarge ? null : collapseContext(diff.rows);
  }, [diffKey, before, after]);

  if (!rows) return null;

  return (
    // whitespace-pre inside an x-scroller: a long line scrolls in place rather
    // than wrapping or widening the panel.
    <div className="border-t border-gray-200 bg-white overflow-x-auto font-mono text-[11px] leading-snug py-1">
      {rows.map((row, index) => (
        row.type === 'gap' ? (
          <div key={index} className="px-3 text-gray-300 italic">
            {`⋯ ${row.count} unchanged line${row.count === 1 ? '' : 's'}`}
          </div>
        ) : (
          <div key={index} className={`px-3 whitespace-pre ${ROW_STYLES[row.type]}`}>
            {`${MARKERS[row.type]} ${row.text}`}
          </div>
        )
      ))}
    </div>
  );
}

export default VersionDiff;
