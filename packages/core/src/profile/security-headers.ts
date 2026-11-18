// Security headers for an installation's documents (installations plan, P3,
// slice 3). Set by the server from the pinned installation, on each response,
// never through /api/config: a browser doesn't choose its own policy.
//
// - The console keeps today's policy byte for byte, with its own API and auth
//   hosts in place of Graffiticode's: without a profile, or with Graffiticode's,
//   the header is exactly what next.config.mjs sent before.
// - The app's documents and the MCP server's HTML pages get a policy only with
//   a profile; without one their responses are unchanged.
// - The mode is the profile's csp.mode, report-only unless it says enforce;
//   without a profile, report-only as today. Enforcement is a separate, later
//   gate per installation.
//
// Node-free, so the Next middleware (edge runtime) can decode what the server
// computed at startup (SECURITY_HEADERS_ENV).
import type { Profile } from "./schema.js";
import type { InstallationHosts } from "./hosts.js";

export type Surface = "console" | "app" | "mcp-page";
export type HeaderPair = [name: string, value: string];
export type CspMode = "report-only" | "enforce";

export const cspHeaderName = (mode: CspMode) =>
  mode === "enforce" ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only";

type Hosts = Pick<InstallationHosts, "api" | "auth">;

// Today's console policy (next.config.mjs until slice 3): report-only, so
// violations surface without breaking the third parties sign-in, payments and
// rendering rely on (Firebase, Stripe, Privy, Google fonts).
export function consoleCsp(h: Hosts): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.stripe.com https://*.firebaseio.com https://*.googleapis.com https://apis.google.com https://*.privy.io https://auth.privy.io",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https: https://*.privy.io",
    `connect-src 'self' https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com https://*.stripe.com ${h.api} ${h.auth} https://*.privy.io https://auth.privy.io wss://*.privy.io https://api.openai.com https://api.anthropic.com`,
    "frame-src 'self' https://*.stripe.com https://*.privy.io https://auth.privy.io",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
}

// The app renders items in frames from the API host and signs in with
// Firebase and Privy; nothing else.
export function appCsp(h: Hosts): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.googleapis.com https://apis.google.com https://*.privy.io https://auth.privy.io",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob: https:",
    `connect-src 'self' ${h.api} ${h.auth} https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com https://*.privy.io https://auth.privy.io wss://*.privy.io`,
    `frame-src 'self' ${h.api} https://*.privy.io https://auth.privy.io`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
}

// The MCP server's HTML pages (about, privacy, terms) are self-contained: an
// inline stylesheet and links.
export function mcpPageCsp(): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

// The headers a surface's documents carry, for this installation.
export function securityHeaders(surface: Surface, profile: Profile | null, hosts: InstallationHosts): HeaderPair[] {
  const mode: CspMode = profile?.csp?.mode ?? "report-only";
  if (surface === "console") return [[cspHeaderName(mode), consoleCsp(hosts)]];
  if (!profile) return [];
  if (surface === "app") return [[cspHeaderName(mode), appCsp(hosts)]];
  return [[cspHeaderName(mode), mcpPageCsp()]];
}

// Handing the headers from the server's startup (Node, where the installation
// is loaded) to the Next middleware (edge runtime, which can't load it). The
// server always overwrites this variable at startup, so a value set from
// outside is never used.
export const SECURITY_HEADERS_ENV = "GC_INSTALLATION_SECURITY_HEADERS";

export const encodeSecurityHeaders = (pairs: HeaderPair[]) => JSON.stringify({ v: 1, headers: pairs });

// The headers, or null when the value is missing or malformed: the middleware
// then refuses to serve rather than send a document without its policy.
export function decodeSecurityHeaders(raw: string | undefined): HeaderPair[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.v !== 1 || !Array.isArray(parsed.headers)) return null;
    for (const h of parsed.headers) {
      if (!Array.isArray(h) || h.length !== 2 || typeof h[0] !== "string" || typeof h[1] !== "string") return null;
      if (!/^[A-Za-z0-9-]+$/.test(h[0]) || /[\r\n]/.test(h[1])) return null;
    }
    return parsed.headers as HeaderPair[];
  } catch {
    return null;
  }
}
