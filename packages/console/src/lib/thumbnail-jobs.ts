// Tracks which items currently have a thumbnail snapshot in flight, so any surface (the item
// ellipsis menu, the tools gallery, …) can show a spinner while an L0013 `snap` is generating.
//
// State is an in-memory module singleton keyed by the SOURCE item id (the item being snapped),
// shared across the whole SPA session. It is intentionally NOT persisted: a snapshot runs as an
// in-flight `compile()` promise, so a full page reload aborts the work — surviving "generating"
// state across a reload would be a lie. Client-side route changes keep the promise (and this
// store) alive, which is what lets the spinner follow the user between pages.
import { useSyncExternalStore } from "react";

// itemId -> ref count (a count, not a boolean, so overlapping re-triggers for the same item
// don't end the job early when the first finishes).
const active = new Map<string, number>();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function beginThumbnailJob(itemId: string) {
  active.set(itemId, (active.get(itemId) || 0) + 1);
  emit();
}

export function endThumbnailJob(itemId: string) {
  const next = (active.get(itemId) || 0) - 1;
  if (next > 0) active.set(itemId, next);
  else active.delete(itemId);
  emit();
}

export function isThumbnailJobActive(itemId: string) {
  return active.has(itemId);
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// Subscribe a component to a single item's job state. Passing no id (e.g. for non-snapshotable
// rows) is allowed and always reports false. getServerSnapshot returns false for SSR.
export function useThumbnailJob(itemId?: string) {
  return useSyncExternalStore(
    subscribe,
    () => (itemId ? active.has(itemId) : false),
    () => false,
  );
}
