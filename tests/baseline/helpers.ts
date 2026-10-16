import assert from "node:assert/strict";
import type { Auth, Harness } from "./harness";

export const ITEM_FIELDS = `id name taskId lang help generationStatus generationError workspace claimToken
  lastWrite { taskId connectionId status message confirmed checkable reconcile { verdict text } }`;

// A prompt long enough for the free plan's 20-character minimum.
export const PROMPT = "Write a short literary passage about a lighthouse keeper.";

export const session = (n: number) => ({ freePlan: `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}` });

export function ok<T = any>(r: { body: { data?: any; errors?: any[] } }): T {
  assert.equal(r.body.errors, undefined, `unexpected errors: ${JSON.stringify(r.body.errors)}`);
  return r.body.data;
}

export function errorOf(r: { body: { errors?: any[] } }) {
  assert.ok(r.body.errors?.length, `expected an error, got ${JSON.stringify(r.body)}`);
  return r.body.errors![0];
}

export async function createItem(h: Harness, auth: Auth, vars: Record<string, unknown> = {}) {
  const r = await h.gql(`mutation($lang:String!,$name:String,$taskId:String,$help:String){
    createItem(lang:$lang, name:$name, taskId:$taskId, help:$help){ ${ITEM_FIELDS} } }`,
  { lang: "0175", name: "item", ...vars }, auth);
  return ok(r).createItem;
}

export async function getItem(h: Harness, auth: Auth, id: string) {
  return h.gql(`query($id:String!){ item(id:$id){ ${ITEM_FIELDS} } }`, { id }, auth);
}

// Starts a generation the way MCP does (startCodeGeneration) and waits for
// the in-process worker to finish.
export async function generate(h: Harness, auth: Auth, vars: Record<string, unknown>) {
  const r = await h.gql(`mutation($itemId:String,$lang:String!,$name:String,$prompt:String!,$modification:String!,$currentSrc:String,$currentData:String){
    startCodeGeneration(itemId:$itemId, lang:$lang, name:$name, prompt:$prompt, modification:$modification, currentSrc:$currentSrc, currentData:$currentData, client:"mcp"){ itemId status workspaceNamespace } }`,
  { lang: "0175", prompt: PROMPT, modification: PROMPT, ...vars }, auth);
  await h.drainJobs();
  return r;
}

// The request fields of the last generation job: the task carries only the job
// id, and they are in its envelope (generation-jobs/{id}, Phase 3.5).
export async function lastJob(h: Harness): Promise<Record<string, any>> {
  const payload = h.jobPayloads.at(-1);
  return (await h.db.doc(`generation-jobs/${payload.generationId}`).get()).data().envelope;
}
