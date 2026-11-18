import { createClient } from "@graffiticode/auth/client";

// The Graffiticode auth client, for the installation's auth host. The host is
// configured from the installation's public configuration (/api/config) when
// the providers mount (configureAuth); there is no built-in host, so using
// the client before that is an error rather than a request to the wrong
// service. Client-side it drives the SIWE nonce + authenticate handshake.
let current: { url: string; client: ReturnType<typeof createClient> } | null = null;

export function configureAuth({ authUrl }: { authUrl: string }) {
  if (!current || current.url !== authUrl) current = { url: authUrl, client: createClient(authUrl) };
}

export const client = new Proxy({} as ReturnType<typeof createClient>, {
  get(_, key) {
    if (!current) throw new Error("The auth host isn't configured: load the installation's configuration first.");
    return (current.client as any)[key];
  },
});
