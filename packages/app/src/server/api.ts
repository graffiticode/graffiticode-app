import bent from "bent";

const apiUrl = process.env.NEXT_PUBLIC_GC_API_URL || "https://api.graffiticode.org";

export const getBaseUrlForApi = () => apiUrl;

export type TaskAuth = { uid?: string; token?: string };

// GET /task?id= — returns the api-store task. Throws bent StatusError on
// non-2xx (e.g. 401/403 when the caller lacks access to a locked task), which
// callers inspect via `err.statusCode` to drive access control.
export async function getApiTask({ auth, id }: { auth?: TaskAuth; id: string }) {
  const headers: Record<string, string> = {};
  if (auth?.token) headers["Authorization"] = auth.token;
  const getApiJSON = bent(apiUrl, "GET", "json");
  const { status, error, data: task } = await getApiJSON(`/task?id=${encodeURIComponent(id)}`, null, headers);
  if (status !== "success") {
    throw new Error(`failed to get task ${id}: ${error?.message}`);
  }
  return task;
}

// POST /task — mints a task and returns { id, ... }. When isPublic is set the
// Authorization header is dropped so the task is created as world-readable.
export async function postTask({
  auth,
  task,
  ephemeral,
  isPublic,
}: {
  auth?: TaskAuth;
  task: any;
  ephemeral?: boolean;
  isPublic?: boolean;
}) {
  const storageType = (ephemeral && "ephemeral") || "persistent";
  const headers: Record<string, string> = { "x-graffiticode-storage-type": storageType };
  if (!isPublic && auth?.token) {
    headers["Authorization"] = auth.token;
  }
  const postApiJSON = bent(apiUrl, "POST", "json");
  const { data } = await postApiJSON("/task", { task }, headers);
  return data;
}

// GET /data?id= — returns the compiled data model for a task (the input the
// form view renders from). Useful for debugging what /form receives.
export async function getData({ accessToken, id }: { accessToken?: string; id: string }) {
  const get = bent(apiUrl, "GET", "json", 200);
  const qs = new URLSearchParams({ id });
  if (accessToken) qs.set("access_token", accessToken);
  const resp = await get(`/data?${qs.toString()}`);
  return resp?.data ?? resp;
}

// POST /compile — binds runtime `data` to task `id`, producing a data-bound
// record. The returned id is the chained task id that captures the new state.
export async function postApiCompile({
  accessToken,
  id,
  data,
}: {
  accessToken?: string;
  id: string;
  data: any;
}) {
  const headers: Record<string, string> = {
    "x-graffiticode-storage-type": "persistent",
  };
  if (accessToken) headers["authorization"] = accessToken;
  const post = bent(apiUrl, "POST", "json", headers);
  const resp = await post("/compile", { id, data });
  if (resp.status !== "success") {
    throw new Error(`failed to post compile ${id}: ${resp.status}`);
  }
  return resp;
}
