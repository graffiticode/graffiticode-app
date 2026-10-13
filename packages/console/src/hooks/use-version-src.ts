// Source text for an item's recorded versions, so the transcript can say what
// each version CHANGED rather than printing its content hash.
//
// Version records are pointer-only (recordVersion() in src/pages/api/resolvers.ts
// never duplicates the code), so the only way to get a version's text is to ask
// for its task. taskIds are content-addressed, which makes every fetch
// permanently cacheable: the module-level cache below is never invalidated, and
// the 8s taskVersions poll costs zero task fetches once an item is warm.

import { useMemo } from 'react';
import useSWR from 'swr';
import { getTask } from '../utils/swr/fetchers';

// Newest N versions we'll pull source for. Bounds the cost of opening an item
// with a long history; older rows fall back to their task id.
export const VERSION_SRC_FETCH_LIMIT = 60;

// Content-addressed ids never change meaning, so entries are immutable. Bounded
// only to keep a long session from growing without limit; insertion order is
// oldest-first, so the first keys are the least recently added.
const MAX_CACHED_SRC = 500;
const srcCache = new Map<string, string>();

const cacheSrc = (taskId: string, src: string) => {
  srcCache.set(taskId, src);
  while (srcCache.size > MAX_CACHED_SRC) {
    const oldest = srcCache.keys().next().value;
    if (oldest === undefined) break;
    srcCache.delete(oldest);
  }
};

// Stable identity so consumers can key a useMemo on the result.
const EMPTY_SRC = new Map<string, string>();

// Small pool: an item's history is fetched one task at a time, and we'd rather
// not open 60 concurrent connections against the API on every item switch.
const CONCURRENCY = 6;

async function fetchSrcs(user: any, taskIds: string[]) {
  const pending = taskIds.filter(id => !srcCache.has(id));
  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const taskId = pending[next++];
      try {
        const task = await getTask({ user, id: taskId });
        // A missing src is indistinguishable from a failed fetch for our
        // purposes: leave it out of the map and the row keeps its id fallback.
        if (task?.src !== undefined && task?.src !== null) cacheSrc(taskId, task.src);
      } catch (error) {
        console.error('Failed to load version source', taskId, error);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker)
  );
  return new Map(
    taskIds.filter(id => srcCache.has(id)).map(id => [id, srcCache.get(id)!])
  );
}

/**
 * @param versions  taskVersions rows for the open item, newest-first
 * @returns Map<taskId, src> for the versions whose source resolved
 */
export function useVersionSrc({ user, versions, itemId }: {
  user: any;
  versions?: any[];
  itemId?: string;
}): Map<string, string> {
  // The key moves only when the version LIST moves, not on every poll — SWR
  // then refetches nothing while the item sits open.
  const taskIds = useMemo(() => {
    if (!Array.isArray(versions)) return [];
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const version of versions) {
      const taskId = version?.taskId;
      if (!taskId || seen.has(taskId)) continue;
      if (itemId && version.itemId !== itemId) continue;
      seen.add(taskId);
      ids.push(taskId);
      if (ids.length >= VERSION_SRC_FETCH_LIMIT) break;
    }
    return ids;
  }, [versions, itemId]);

  const { data } = useSWR(
    user && taskIds.length ? `version-src-${itemId}-${taskIds.join(',')}` : null,
    () => fetchSrcs(user, taskIds),
    {
      // Sources are immutable; only a new taskId is ever worth a request.
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      revalidateIfStale: false,
      // Keep the stats on screen while a newly added version is being fetched.
      keepPreviousData: true,
    }
  );

  return data ?? EMPTY_SRC;
}
