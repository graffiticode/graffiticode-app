import { createClient } from "@graffiticode/auth/client";

const authUrl = process.env.NEXT_PUBLIC_GC_AUTH_URL || "https://auth.graffiticode.org";

// Isomorphic Graffiticode auth client. Client-side it drives the SIWE nonce +
// authenticate handshake; server-side it verifies Firebase ID tokens / JWTs
// (client.verifyToken) for the `graffiticode` project.
export const client = createClient(authUrl);
