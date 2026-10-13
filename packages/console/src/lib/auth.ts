import { createClient } from "@graffiticode/auth/client";

const authUrl = process.env.NEXT_PUBLIC_GC_AUTH_URL || "https://auth.graffiticode.org";
export const client = createClient(authUrl);
