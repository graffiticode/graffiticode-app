// Publications of items run through a connection (delegated API permissions).
// The gateway checks that the item's current private result belongs to the
// caller for that connection; policy holds the record and re-checks it live on
// every view. The console only asks, as the signed-in user.
import bent from "bent";
import { getBaseUrlForApi } from "./api";

export class PublicationError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const call = async (method: "POST" | "DELETE", path: string, authToken: string, body?: unknown) => {
  const request = bent(getBaseUrlForApi(), method, "json", 200, 400, 401, 403, 404, 409, 501, { authorization: authToken });
  const res: any = await request(path, body);
  if (res?.status !== "success") {
    const status = typeof res?.error?.code === "number" ? res.error.code : 502;
    throw new PublicationError(res?.error?.message || "publication request failed", status);
  }
  return res.data;
};

export const createPublication = async ({ authToken, taskId, connectionId }: { authToken: string; taskId: string; connectionId: string }) =>
  (await call("POST", "/publications", authToken, { id: taskId, connectionId })).publicationId as string;

export const deletePublication = ({ authToken, publicationId }: { authToken: string; publicationId: string }) =>
  call("DELETE", `/publications/${encodeURIComponent(publicationId)}`, authToken);
