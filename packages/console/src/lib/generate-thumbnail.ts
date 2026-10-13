// Generate (or refresh) the gallery thumbnail for an item by driving the L0013 "screenshot"
// dialect: build a `snap item "<id>" {}` program, post it as a task, attach it to a real L0013
// item named after the source id (so the user can open and refine it later), then compile the
// task — the compile is what runs the headless render + uploads thumbnails/<id>.png.
//
// Reuses an existing L0013 entry named after the item when one is present, so repeated runs
// refine in place rather than piling up duplicates.
import { parse, postTask, createItem, updateItem, loadItems, compile } from "../utils/swr/fetchers";
import { beginThumbnailJob, endThumbnailJob } from "./thumbnail-jobs";

const SNAP_LANG = "0013";

// The L0013 source that snaps an item with the default (content-aware) crop. The trailing `..`
// terminates the statement, per the dialect grammar.
const snapSrc = (itemId: string) => `snap item "${itemId}" {}..`;

export async function generateThumbnail({ user, itemId }: { user: any; itemId: string }) {
  if (!user || !itemId) return null;
  beginThumbnailJob(itemId);
  try {
    // Parse the snap program to an AST, then post it as the L0013 task.
    const parsed = await parse({ user, lang: SNAP_LANG, src: snapSrc(itemId) });
    if (parsed?.errors?.length) {
      throw new Error(parsed.errors.map((e: any) => e.message).join("; "));
    }
    const taskId = await postTask({ user, lang: SNAP_LANG, code: parsed.code });
    if (!taskId) throw new Error("snap task post returned no id");

    // Find-or-create the L0013 item named after the source item id.
    const existing = await loadItems({ user, lang: SNAP_LANG, mark: null, client: "console" });
    const prior = (existing || []).find((it: any) => it.name === itemId);
    const snapItem = prior
      ? await updateItem({ user, id: prior.id, taskId })
      : await createItem({ user, lang: SNAP_LANG, name: itemId, taskId, client: "console" });

    // Compile the L0013 task — this triggers the headless render and uploads the PNG. ~10s.
    await compile({ user, id: taskId });
    return snapItem;
  } finally {
    endThumbnailJob(itemId);
  }
}
