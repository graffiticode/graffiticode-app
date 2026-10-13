import React, { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getSpec } from '../utils/swr/fetchers';

/**
 * How long an item must stay selected before its spec is requested.
 *
 * Arriving on an item is not the same as wanting its spec. The tab choice persists in
 * localStorage, so scrolling the item list with Spec open used to fire one request per item passed
 * — and a request is a MODEL CALL on a cache miss (L0177 runs spec-gen on Sonnet against a ~30KB
 * instructions.md, ~$0.05 an item), silently, with nothing in the UI to suggest arriving spent
 * anything. Six items of scrolling did exactly that.
 *
 * 750ms is above a scroll-past and below deliberate reading. The cost is that a CACHED spec also
 * waits, since the client cannot know it is cached without asking — a fixed delay on the hit path
 * in exchange for not generating on the miss path, which is the trade worth making when one side
 * costs milliseconds and the other costs money.
 */
const SETTLE_MS = 750;

/**
 * `onLoaded` hands the RAW markdown up to the editor, which owns the Copy All button.
 *
 * Raw, not the rendered DOM: a spec is written to be pasted into another language's create_item
 * (or an agent's context), and for a dialect whose spec is a developer recipe the headings and
 * numbered verification steps are load-bearing structure. Copying the rendered text would flatten
 * exactly the part that makes it followable.
 */
export function SpecPanel({ id, user, taskId, onLoaded }: any) {
  // What is being described is the (item, task) pair, not the item — so both the settle timer and
  // the SWR key are derived from both.
  //
  // The taskId is what makes the client's cache identity match the server's. The server validates
  // its stored spec against the taskId (isSpecCacheHit in resolvers), so editing an item misses
  // that cache and regenerates; but the client keyed only on the item id, which does not change
  // when you edit, so SWR served its in-memory copy and the panel kept showing a spec of the
  // PREVIOUS code — with revalidateOnFocus off, until a full reload. A taskId is content-addressed,
  // so keying on it means any content change invalidates both caches and no content change
  // invalidates either.
  const target = id && taskId ? `${id}::${taskId}` : null;
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    if (!target) { setSettled(null); return; }
    // Keyed on the pair, so a debounced re-post while typing restarts the wait instead of firing a
    // generation per keystroke — the cost here is a model call, not just a fetch.
    const timer = setTimeout(() => setSettled(target), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [target]);

  const ready = Boolean(user && target && settled === target);
  const { data: spec, error, isLoading } = useSWR(
    ready ? [`getSpec-${target}`, { user, id }] : null,
    ([_, params]) => getSpec(params),
    { revalidateOnFocus: false }
  );

  const remarkPlugins = useMemo(() => [remarkGfm], []);

  // Publish on every transition, including back to empty: the button must disappear while a
  // different item is settling or loading rather than stay live over the previous item's text.
  const text = (ready && !isLoading && !error && spec?.spec) || "";
  useEffect(() => { onLoaded?.(text); }, [text, onLoaded]);

  // An item with no task has nothing to describe, and it never will until it compiles — so say so
  // rather than spinning. Before the key included taskId this fell out for free: the fetch ran,
  // failed, and hit the error branch below. Now `target` is null and `ready` never becomes true,
  // which would spin forever.
  if (id && !taskId) {
    return (
      <div className="p-4 text-sm text-gray-500">
        No spec available — compile the item first.
      </div>
    );
  }

  // One spinner for both waits, but it turns BACKWARDS while settling and flips forward the moment
  // the request actually goes out. Same shape, same place, no label — the only thing that changes
  // is direction, which reads as "something just started" without claiming a word for it. Scrolling
  // past several items shows a spinner that never flips, which is the honest picture: nothing was
  // requested. `animationDirection: reverse` reuses Tailwind's existing `animate-spin` keyframes,
  // so this needs no config and cannot drift from the forward state's timing.
  if (!ready || isLoading) {
    const settling = !ready;
    return (
      <div className="flex items-center justify-center h-full p-8">
        <div
          className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"
          style={settling ? { animationDirection: "reverse" } : undefined}
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-sm text-gray-500">
        No spec available — compile the item first.
      </div>
    );
  }

  if (!spec || !spec.spec) {
    return <div className="h-full bg-white" />;
  }

  return (
    <div className="h-full bg-white">
      <div className="prose prose-sm prose-blue max-w-none p-4">
        <ReactMarkdown remarkPlugins={remarkPlugins}>
          {spec.spec}
        </ReactMarkdown>
      </div>
    </div>
  );
}
