// The preparation behind MCP's create_item and update_item, ported from
// packages/mcp-server/src/tools.ts so every transport can share it (Phase 1).
// MCP keeps its own copy until Phase 3 moves it onto core; until then a
// baseline test checks the two produce the same generation job.
import { getItem } from "./items.js";
import { getTask, readItemData } from "./tasks.js";
import { resolveAuth, type RequestCredentials } from "./auth.js";
import { startGeneration } from "./generation.js";
import { NotFoundError } from "./errors.js";

type HelpEntry = {
  user: string;
  help: { type?: "code"; text: string };
  type: "user";
  timestamp: string;
  taskId?: string;
};

export function parseHelp(helpJson: string | null | undefined): HelpEntry[] {
  if (!helpJson) return [];
  try {
    const parsed: unknown = JSON.parse(helpJson);
    return Array.isArray(parsed) ? parsed as HelpEntry[] : [];
  } catch {
    return [];
  }
}

export function buildContextualPrompt(help: HelpEntry[], newMessage: string): string {
  // If no meaningful history, just return the new message
  if (help.length < 1) return newMessage;

  let context = "Previous conversation:\n\n";
  const limitedHistory = help.slice(-6); // Last 6 messages (3 exchanges)

  for (const item of limitedHistory) {
    context += `User: ${item.user}\n`;
    if (item.taskId) {
      context += `Assistant: [Generated Graffiticode code]\n`;
    }
  }

  // NB: we deliberately do NOT inline the current source here. generateCode()
  // already receives it as the typed `currentSrc` argument, so embedding it in
  // the prompt text is redundant — and on the free-plan path it pushed the
  // prompt past the backend's 2000-char cap, failing every edit of a non-trivial
  // item. Keep the prompt to conversation history + the new request only.
  context += "\nNow, please address this new request:\n";
  return context + newMessage;
}

// A description that is really an item id or a pasted AST, not a request.
export function detectForwardedArtifact(description: string): string | null {
  const d = (description ?? "").trim();
  // A bare item-id token: one long alnum run, no spaces. A real request always has words.
  if (/^[A-Za-z0-9_-]{16,}$/.test(d)) {
    return "That looks like an item id, not content — item ids are opaque handles. Call get_spec(item_id) and pass its returned text (plus your intent framing) as the description.";
  }
  // A pasted AST node pool (get_item code/data), not a natural-language request.
  if (/"tag"\s*:/.test(d) && /"elts"\s*:/.test(d)) {
    return "That looks like a language-private artifact (an AST/data blob), not a request. Don't forward get_item output across languages — call get_spec(item_id) for a platform-neutral description and pass that instead.";
  }
  return null;
}

// How much of an item's compiled record travels with an update: the generator
// renders at most 6KB of it, so a little above that loses nothing it would use.
const MAX_CURRENT_DATA_CHARS = 8000;
// An edit must not wait long on a decoration.
const CURRENT_DATA_TIMEOUT_MS = 5_000;

function isErrorEnvelope(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.status !== "error") return false;
  const err = o.error as Record<string, unknown> | undefined;
  return !!err && typeof err === "object" && typeof err.code === "number";
}

function isErrorDataPayload(data: unknown): boolean {
  if (isErrorEnvelope(data)) return true;
  if (data && typeof data === "object") {
    return isErrorEnvelope((data as Record<string, unknown>).data);
  }
  return false;
}

// The item's compiled record, serialized, or null — never a throw. Every
// failure (no task, a slow or failed fetch, an error envelope, a record too
// large to be worth sending) lands on null and the update proceeds without it.
async function currentDataFor(auth: any, taskId: string | null | undefined): Promise<string | null> {
  if (!taskId) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const data = await Promise.race([
      readItemData({ auth, id: taskId }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), CURRENT_DATA_TIMEOUT_MS); }),
    ]);
    if (data == null || isErrorDataPayload(data)) return null;
    const serialized = JSON.stringify(data);
    if (!serialized || serialized.length > MAX_CURRENT_DATA_CHARS) return null;
    return serialized;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

type Hints = { client?: string; clientKind?: string; geoCountry?: string };

// create_item: a new item generated from a natural-language description.
export async function createFromDescription(
  ctx: RequestCredentials & Record<string, unknown>,
  { lang, description, name, siblingOf, client, clientKind, geoCountry, idempotency }:
    { lang: string; description: string; name?: string; siblingOf?: string; idempotency?: unknown } & Hints,
) {
  const misuse = detectForwardedArtifact(description);
  if (misuse) throw new Error(misuse);
  return startGeneration(ctx, {
    lang: String(lang).replace(/^L/i, ""),
    name,
    siblingOf,
    client,
    clientKind,
    geoCountry,
    prompt: description,
    modification: description,
    idempotency,
  });
}

// update_item: a revision of an existing item. The prompt carries the
// conversation and the new request; the current source and compiled data travel
// as their own arguments.
export async function reviseItem(
  ctx: RequestCredentials & Record<string, unknown>,
  { itemId, modification, client, clientKind, geoCountry, idempotency }: { itemId: string; modification: string; idempotency?: unknown } & Hints,
) {
  const auth = await resolveAuth(ctx);
  const item: any = await getItem({ auth, id: itemId, connectionFields: false });
  if (!item) throw new NotFoundError(`Item not found: ${itemId}`);
  const currentSrc = item.taskId ? ((await getTask({ auth, id: item.taskId }))?.src ?? null) : null;
  const prompt = buildContextualPrompt(parseHelp(item.help), modification);
  const currentData = await currentDataFor(auth, item.taskId);
  return startGeneration(ctx, {
    itemId,
    lang: item.lang,
    client,
    clientKind,
    geoCountry,
    prompt,
    modification,
    currentSrc,
    currentData,
    baseTaskId: item.taskId ?? null,
    idempotency,
  });
}
