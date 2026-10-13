// Task API primitives: parse source to an AST pool, post a task, read compiled
// data. Extracted from pages/api/resolvers.ts so the code-generation layer can
// reach them without importing a Next.js API module — resolvers.ts imports the
// generation service, so the reverse edge would be a cycle.
//
// resolvers.ts re-exports all three, so its own call sites and any external
// importer keep working unchanged.
import bent from "bent";
import { parser } from "@graffiticode/parser";
import {
  getBaseUrlForApi,
  getLanguageLexicon,
  languageOfflineMessage,
  isLanguageOfflineError,
} from "./api";

function buildParseCallbacks(
  { publicValues = {} }:
  { publicValues?: Record<string, string> } = {},
) {
  return {
    // Private values are retired (capability spec SECRET-01): credentials
    // never enter a task AST, so `get-val-private` bakes "" — the value such
    // programs already received, since nothing supplies private values — and
    // the console holds no encryption key.
    GET_VAL_PRIVATE: (_name: string) => "",
    GET_VAL_PUBLIC: (name: string) => {
      const result = publicValues[name] || "";
      console.log("GET_VAL_PUBLIC()", "name:", name, "result:", result);
      return result;
    },
  };
}

export async function parseCode(
  { lang, src, publicValues = {}, accessToken }:
  { lang: string; src: string; publicValues?: Record<string, string>; accessToken?: string },
) {
  try {
    const lexicon = await getLanguageLexicon(lang, accessToken);
    if (!lexicon) {
      // lexicon.json couldn't be fetched — treat the language service as offline.
      return { code: null, errors: [{ message: languageOfflineMessage(lang), from: -1, to: -1 }] };
    }
    const nodePool = await parser.parse(lang, src, lexicon, buildParseCallbacks({ publicValues }));

    // Scan the AST pool for ERROR nodes
    const errors: Array<{ message: string; from: number; to: number }> = [];
    for (const key of Object.keys(nodePool)) {
      if (key === "root") continue;
      const node = nodePool[key];
      if (node && node.tag === "ERROR") {
        // ERROR node elts: [STR_nid, NUM_nid(from), NUM_nid(to)]
        const msgNode = nodePool[node.elts[0]];
        const fromNode = nodePool[node.elts[1]];
        const toNode = nodePool[node.elts[2]];
        const message = typeof msgNode === "string" ? msgNode
          : (msgNode?.tag === "STR" ? msgNode.elts[0] : String(msgNode));
        const from = typeof fromNode === "number" ? fromNode
          : (fromNode?.tag === "NUM" ? Number(fromNode.elts[0]) : -1);
        const to = typeof toNode === "number" ? toNode
          : (toNode?.tag === "NUM" ? Number(toNode.elts[0]) : -1);
        errors.push({ message, from, to });
      }
    }

    if (errors.length > 0) {
      return { code: null, errors };
    }
    return { code: JSON.stringify(nodePool), errors: null };
  } catch (err) {
    if (isLanguageOfflineError(err)) {
      return { code: null, errors: [{ message: languageOfflineMessage(lang), from: -1, to: -1 }] };
    }
    return { code: null, errors: [{ message: err.message || "Parse error", from: -1, to: -1 }] };
  }
}

const postApiJSON = bent(getBaseUrlForApi(), "POST", "json");

export async function postTask({ auth, task, ephemeral, isPublic }) {
  try {
    const storageType = (ephemeral && "ephemeral") || "persistent";
    const headers = {
      Authorization: auth.token,
      "x-graffiticode-storage-type": storageType,
    };
    if (isPublic) {
      delete headers.Authorization;
    }
    const { data } = await postApiJSON("/task", { task }, headers);
    return data;
  } catch (x) {
    console.error("postTask()", "ERROR", x);
    const message = x && typeof x === "object" && "message" in x
      ? String((x as { message: unknown }).message)
      : "task post failed";
    throw new Error(`postTask: ${message}`);
  }
}

// Runs a program through a connection: the compile that executes its protected
// calls (item-bank saves included) and stores the result views then show. The
// idempotency key names this write; the same key never writes twice. Error
// statuses come back as the api's JSON body rather than a throw, so the caller
// can report the api's own message.
export async function compileThroughConnection(
  { authToken, id, connectionId, idempotencyKey }:
  { authToken: string; id: string; connectionId: string; idempotencyKey: string },
) {
  const post = bent(getBaseUrlForApi(), "POST", "json", 200, 400, 401, 403, 404, 409, 422, 500, 502, 503, {
    authorization: authToken,
    "x-graffiticode-storage-type": "persistent",
  });
  return await post("/compile", { id, data: {}, connectionId, idempotencyKey }) as any;
}

// Compiles a task afresh instead of answering from the compile cache, and
// stores the new result (api GET /data?refresh=1, which requires a signed-in
// caller). The token travels in a header, never the URL, so it stays out of
// request logs. Error statuses come back as the api's JSON body.
export async function recompileTask({ authToken, id }: { authToken: string; id: string }) {
  const get = bent(getBaseUrlForApi(), "GET", "json", 200, 400, 401, 403, 404, 500, 502, 503, {
    authorization: authToken,
  });
  return await get(`/data?id=${encodeURIComponent(id)}&refresh=1`) as any;
}

// With a connection, this is a view of the caller's stored result for the
// item through that connection: the gateway never runs the program for it.
export async function getData({ authToken, id, connectionId = null }: { authToken: string; id: string; connectionId?: string | null }) {
  try {
    const baseUrl = getBaseUrlForApi();
    const get = bent(baseUrl, "GET", "json", 200);
    const connection = connectionId ? `&connection=${encodeURIComponent(connectionId)}` : "";
    const resp = await get(`/data?id=${id}&access_token=${authToken}${connection}`);
    return resp.data;
  } catch (x) {
    console.log("getData()", "ERROR", x);
  }
}
