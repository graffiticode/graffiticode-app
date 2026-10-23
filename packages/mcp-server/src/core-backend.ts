// GRAFFITICODE_BACKEND=core: answer the console GraphQL operations this server
// sends by calling @graffiticode-app/core in-process instead of over HTTP
// (Phase 3). Each operation mirrors its console resolver exactly — same
// selection, same GraphQL scalar coercion, same errors — so api.ts and the tools
// above it can't tell the difference. The default stays "graphql".
import { admitRequest, resolveAuth, type RequestCredentials } from "@graffiticode-app/core/auth";
import { getItem } from "@graffiticode-app/core/items";
import { getTask, readItemData } from "@graffiticode-app/core/tasks";
import { startGeneration } from "@graffiticode-app/core/generation";
import { createFromDescription, reviseItem } from "@graffiticode-app/core/revise";
import { NotFoundError } from "@graffiticode-app/core/errors";
import { listLanguages, getLanguageInfo } from "@graffiticode-app/core/languages-info";
import type { AuthContext } from "./api.js";
import { parseFreePlanError, parseFreePlanErrorBody } from "./free-plan-limit.js";

export const coreBackendEnabled = () => process.env.GRAFFITICODE_BACKEND === "core";

// Operations that call an LLM stay on the console, the one service that holds
// the model key, beside the generator they share it with: in core mode they
// still go over GraphQL. (Generation already does: this server only reserves
// the job, and the console's worker runs it.)
const CONSOLE_ONLY = new Set(["GetSpec"]);
export const coreHandles = (query: string) => !CONSOLE_ONLY.has(/(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "");

type Ctx = RequestCredentials & { clientKind?: string; geoCountry?: string };

// The context the console's handler builds for this caller: a bearer passes
// through; a free-plan session is admitted (signature + burst guard) first.
async function contextFor(auth: AuthContext): Promise<Ctx> {
  if (auth.type === "firebase") return { token: auth.token };
  let admitted: Awaited<ReturnType<typeof admitRequest>>;
  try {
    admitted = await admitRequest({ headers: { "x-free-plan-session": auth.sessionId } });
  } catch (err) {
    // The console answers a refused session with a non-2xx JSON body.
    const payload = JSON.stringify((err as any)?.payload || { error: "free_plan_session_invalid" });
    throw parseFreePlanErrorBody(payload) ?? new Error(`GraphQL request failed: ${payload}`);
  }
  return admitted.freePlan
    ? { freePlan: true, sessionNamespace: admitted.sessionNamespace, sessionUuid: admitted.sessionUuid }
    : { token: undefined };
}

// GraphQL scalar coercion, as the console's schema applies it.
class NonNull extends Error {}
const nonNull = <T>(v: T, field: string): NonNullable<T> => {
  if (v === null || v === undefined) throw new NonNull(`Cannot return null for non-nullable field ${field}.`);
  return v as NonNullable<T>;
};
const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  throw new Error(`String cannot represent value: ${JSON.stringify(v)}`);
};
const int = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const bool = (v: unknown): boolean | null => (v === null || v === undefined ? null : Boolean(v));
const strs = (v: unknown): string[] | null => (Array.isArray(v) ? v.map(x => nonNull(str(x), "[String!]")) : v == null ? null : nonNull(null, "[String!]"));

function task(t: any) {
  if (!t) return null;
  return {
    id: nonNull(str(t.id), "Task.id"),
    lang: nonNull(str(t.lang), "Task.lang"),
    code: nonNull(str(t.code), "Task.code"),
    src: nonNull(str(t.src), "Task.src"),
  };
}

async function item(i: any, ctx: Ctx, withGeneration: boolean, withTask: boolean) {
  if (!i) return null;
  const out: Record<string, unknown> = {
    id: nonNull(str(i.id), "Item.id"),
    name: nonNull(str(i.name), "Item.name"),
    taskId: str(i.taskId),
    lang: nonNull(str(i.lang), "Item.lang"),
    help: str(i.help),
    isPublic: bool(i.isPublic),
    created: nonNull(str(i.created), "Item.created"),
    updated: str(i.updated),
    client: str(i.client),
    claimToken: str(i.claimToken),
  };
  if (withGeneration) {
    out.generationStatus = str(i.generationStatus);
    out.generationError = str(i.generationError);
    out.generationStartedAt = str(i.generationStartedAt);
    out.generationDeadlineAt = str(i.generationDeadlineAt);
    out.generationChars = int(i.generationChars);
  }
  if (withTask) {
    // Item.task: resolved only when the item has a program (index.ts Item.task).
    out.task = i.taskId ? task(await getTask({ auth: await resolveAuth(ctx), id: i.taskId })) : null;
  }
  return out;
}

const language = (l: any) => ({
  id: nonNull(str(l.id), "Language.id"),
  name: nonNull(str(l.name), "Language.name"),
  description: nonNull(str(l.description), "Language.description"),
  routingHint: str(l.routingHint),
  domains: nonNull(strs(l.domains), "Language.domains"),
});

function languageInfo(l: any) {
  if (!l) return null;
  return {
    ...language(l),
    specUrl: nonNull(str(l.specUrl), "LanguageInfo.specUrl"),
    authoringGuide: str(l.authoringGuide),
    supportedItemTypes: strs(l.supportedItemTypes),
    examplePrompts: Array.isArray(l.examplePrompts)
      ? l.examplePrompts.map((p: any) => ({ prompt: nonNull(str(p.prompt), "ExamplePrompt.prompt"), produces: str(p.produces), notes: str(p.notes) }))
      : null,
    usageGuide: str(l.usageGuide),
    scope: l.scope
      ? {
        summary: nonNull(str(l.scope.summary), "LanguageScope.summary"),
        inScope: nonNull(strs(l.scope.inScope), "LanguageScope.inScope"),
        outOfScope: nonNull(strs(l.scope.outOfScope), "LanguageScope.outOfScope"),
      }
      : null,
  };
}

const job = (j: any) => ({
  itemId: nonNull(str(j.itemId), "GenerationJob.itemId"),
  status: nonNull(str(j.status), "GenerationJob.status"),
  workspaceNamespace: str(j.workspaceNamespace),
});

async function run(op: string, ctx: Ctx, v: Record<string, any>): Promise<Record<string, unknown>> {
  switch (op) {
    case "StartCodeGeneration":
      return { startCodeGeneration: job(nonNull(await startGeneration(ctx, v), "Mutation.startCodeGeneration")) };
    case "GetData": {
      const auth = await resolveAuth(ctx);
      const data = JSON.stringify(await readItemData({ auth, id: v.id, connectionId: v.connectionId ?? null }));
      return { data: nonNull(data, "Query.data") };
    }
    case "GetTask":
      return { task: task(await getTask({ auth: await resolveAuth(ctx), id: v.id })) };
    // MCP shows no connection fields, so the Policy lookup behind them is skipped.
    case "GetItem":
      return { item: await item(await getItem({ auth: await resolveAuth(ctx), id: v.id, connectionFields: false }), ctx, false, false) };
    case "GetItemWithTask":
      return { item: await item(await getItem({ auth: await resolveAuth(ctx), id: v.id, connectionFields: false }), ctx, true, true) };
    case "ListLanguages": {
      // As the languages resolver: internal dialects never reach the catalog.
      const all = await listLanguages({ search: v.search, domain: v.domain });
      return { languages: all.filter((l: any) => !l.internal).map(language) };
    }
    case "GetLanguageInfo":
      return { language: languageInfo(await getLanguageInfo(v.id)) };
    default:
      throw new Error(`GRAFFITICODE_BACKEND=core does not support operation ${op}`);
  }
}

// The errors graphqlRequest raises for the same failure over HTTP.
function asGraphqlError(err: any): Error {
  const limit = err?.extensions ? parseFreePlanError(err.extensions, err.message) : null;
  return limit ?? new Error(`GraphQL error: ${err?.message ?? err}`);
}

export async function coreExecute(auth: AuthContext, query: string, variables: Record<string, unknown>): Promise<any> {
  const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "";
  const ctx = await contextFor(auth);
  try {
    return await run(op, ctx, variables as Record<string, any>);
  } catch (err) {
    throw asGraphqlError(err);
  }
}

// create_item / update_item in core mode: the shared preparation in
// @graffiticode-app/core/revise, rather than this server's copy.
export async function coreCreateItem(auth: AuthContext, args: Parameters<typeof createFromDescription>[1]) {
  const ctx = await contextFor(auth);
  try {
    return job(await createFromDescription(ctx, args));
  } catch (err) {
    throw asGraphqlError(err);
  }
}

export async function coreReviseItem(auth: AuthContext, args: Parameters<typeof reviseItem>[1]) {
  const ctx = await contextFor(auth);
  try {
    return job(await reviseItem(ctx, args));
  } catch (err) {
    // This server reports a missing item itself, unwrapped (handleUpdateItem).
    if (err instanceof NotFoundError) throw new Error(err.message);
    throw asGraphqlError(err);
  }
}
