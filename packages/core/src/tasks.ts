// Moved from pages/api/resolvers.ts (Phase 1: untangle inside the console).
import type { AuthArg } from "./types.js";
import { getData } from "./lib/task-api.js";
import { getApiTask, getLanguageLexicon } from "./lib/api.js";
import { unparse } from "@graffiticode/parser";

export async function getTask({ auth, id }) {
  try {
    const apiTask = await getApiTask({ id, auth });
    const taskList = Array.isArray(apiTask) ? apiTask : [apiTask];
    const taskData = taskList[0] || apiTask;
    const code = taskData.code;
    const codeStr = JSON.stringify(code, null, 2);
    let src = "";
    try {
      const lexicon = await getLanguageLexicon(taskData.lang, auth?.token);
      src = unparse(code, lexicon || {});
    } catch (err) {
      console.error("getTask: failed to unparse", err);
    }
    const langs = taskList
      .map(t => t && t.lang)
      .filter(l => typeof l === "string" && l.length > 0);
    return { id, lang: taskData.lang, code: codeStr, src, langs };
  } catch (error) {
    console.error("getTask()", "ERROR", error);
    throw new Error(`Failed to get task: ${error.message}`);
  }
}

// A task's compiled data. A connection is a full-account feature, so a
// free-plan caller's connectionId is ignored: it previews like any other item.
export async function readItemData({ auth, id, connectionId = null }: { auth: AuthArg; id: string; connectionId?: string | null }) {
  return getData({ authToken: auth.token, id, connectionId: auth.freePlan ? null : connectionId });
}
