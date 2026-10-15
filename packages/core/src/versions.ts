// Moved from pages/api/resolvers.ts (Phase 1: untangle inside the console).
import { db } from "./db.js";
import { freePlanItemFields } from "./claims.js";
import type { AuthArg } from "./types.js";
import { requireFullAccount } from "./errors.js";

// How a version came to be. Best-effort provenance: callers that know pass it,
// everything else falls back to the item's client tag.
export type VersionSource =
  | "chat"
  | "editor"
  | "mcp"
  | "generation-job"
  | "claim"
  | "share"
  | "backfill"
  | "unknown";

export const VERSION_LABEL_MAX = 200;

export const VERSION_SOURCES: VersionSource[] = [
  "chat",
  "editor",
  "mcp",
  "generation-job",
  "claim",
  "share",
  "backfill",
  "unknown",
];

// `source` reaches us from a GraphQL arg, so it's caller-supplied — clamp it to
// the known set rather than storing whatever a client sends.
export function normalizeVersionSource(source: unknown): VersionSource | undefined {
  if (typeof source !== "string") return undefined;
  return VERSION_SOURCES.includes(source as VersionSource)
    ? (source as VersionSource)
    : undefined;
}

// Callers that know how a change originated pass `source` explicitly; otherwise
// the item's client tag is the best available signal.
export function defaultVersionSource(client?: string): VersionSource {
  if (client === "mcp") return "mcp";
  return "unknown";
}

// Append-only record of one content state of an item. Pointer-only: the taskId is
// content-addressed and permanently stored by api.graffiticode.org, so the code
// itself is never duplicated here (see docs/item-versioning.md).
//
// Doc id is `${itemId}__${taskId}`, which makes writes idempotent by construction:
// generate-job retries, double-saves, and reverting to an earlier state (which
// yields the SAME taskId, since tasks are content-addressed) all collapse onto the
// existing doc rather than piling up rows.
//
// Never throws — a failed version write must not fail the mutation that triggered it.
export async function recordVersion({
  auth,
  itemId,
  taskId,
  lang,
  upstreamLangs,
  name,
  mark,
  client,
  source = "unknown",
  label,
  createdAt = Date.now(),
}: {
  auth: AuthArg;
  itemId: string;
  taskId: string;
  lang: string;
  upstreamLangs?: string[];
  name?: string;
  mark?: number;
  client?: string;
  source?: VersionSource;
  label?: string;
  createdAt?: number;
}) {
  try {
    if (!itemId || !taskId || !lang) return;
    const upstream = Array.isArray(upstreamLangs) ? upstreamLangs : [];
    const version: Record<string, any> = {
      itemId,
      taskId,
      lang,
      upstreamLangs: upstream,
      // Denormalized head-first chain, so the tasks list can filter by lang
      // sequence without a round-trip per compound task.
      langs: [lang, ...upstream],
      name: name ?? null,
      mark: mark ?? null,
      client: client ?? "console",
      source,
      createdAt,
    };
    if (label) {
      version.label = String(label).slice(0, VERSION_LABEL_MAX);
    }
    if (auth.freePlan) {
      Object.assign(version, freePlanItemFields(auth, createdAt));
    }
    const ref = db().doc(`users/${auth.uid}/versions/${itemId}__${taskId}`);
    // create-if-absent, NOT set/merge: reverting to an earlier state re-derives
    // the same content-addressed taskId, and merging would overwrite that
    // version's original createdAt/source — silently rewriting history and
    // yanking an old row to the top of the list. Record the revisit instead.
    try {
      await ref.create(version);
    } catch (err: any) {
      // 6 = ALREADY_EXISTS
      if (err?.code === 6) {
        await ref.update({ lastSeenAt: createdAt });
      } else {
        throw err;
      }
    }
  } catch (error) {
    console.error("recordVersion()", "ERROR", itemId, taskId, error);
  }
}

export const TASK_VERSIONS_DEFAULT_LIMIT = 200;
export const TASK_VERSIONS_MAX_LIMIT = 1000;

// The tasks list: every recorded content state for a language, newest first.
// Replaces the `compiles` feed, which went silent once /data responses started
// being edge-served and the api's origin callback stopped firing.
export async function getTaskVersions({
  auth,
  lang,
  client,
  itemId,
  limit,
  startAfter,
}: {
  auth: AuthArg;
  lang: string;
  client?: string;
  itemId?: string;
  limit?: number;
  startAfter?: string;
}) {
  requireFullAccount(auth, "history");
  try {
    let query = db()
      .collection(`users/${auth.uid}/versions`)
      .where("lang", "==", lang) as FirebaseFirestore.Query;
    if (client && client !== "all") {
      query = query.where("client", "==", client);
    }
    if (itemId) {
      query = query.where("itemId", "==", itemId);
    }
    query = query.orderBy("createdAt", "desc");
    if (startAfter) {
      const cursor = Number(startAfter);
      if (Number.isFinite(cursor)) {
        query = query.startAfter(cursor);
      }
    }
    const capped = Math.min(
      Math.max(Number(limit) || TASK_VERSIONS_DEFAULT_LIMIT, 1),
      TASK_VERSIONS_MAX_LIMIT,
    );
    const snap = await query.limit(capped).get();
    return snap.docs.map((doc) => {
      const data = doc.data();
      const upstreamLangs = Array.isArray(data.upstreamLangs) ? data.upstreamLangs : [];
      return {
        id: doc.id,
        itemId: data.itemId,
        taskId: data.taskId,
        lang: data.lang,
        // Older records predate the denormalized chain; derive it when missing.
        langs: Array.isArray(data.langs) && data.langs.length
          ? data.langs
          : [data.lang, ...upstreamLangs],
        name: data.name ?? null,
        mark: data.mark ?? null,
        client: data.client ?? "console",
        source: data.source ?? "unknown",
        label: data.label ?? null,
        createdAt: String(data.createdAt),
      };
    });
  } catch (error) {
    console.error("getTaskVersions()", "ERROR", error);
    throw new Error(`Failed to get task versions: ${error.message}`);
  }
}
