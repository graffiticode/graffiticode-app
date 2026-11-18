import { createClient } from "@graffiticode/auth/client";
import { coreConfig } from "@graffiticode-app/core/config";

// The auth service client, for the installation's auth host, resolved on use
// (core config): on the server, the installation profile's host; in the
// browser, the build's. Re-created only if the host changes.
let current: { url: string; client: ReturnType<typeof createClient> } | null = null;
function authClient() {
  const url = coreConfig().authUrl;
  if (!current || current.url !== url) current = { url, client: createClient(url) };
  return current.client;
}
export const client = new Proxy({} as ReturnType<typeof createClient>, {
  get: (_, key) => (authClient() as any)[key],
});
