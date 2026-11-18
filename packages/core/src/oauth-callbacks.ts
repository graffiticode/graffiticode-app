// Where the console's OAuth consent page may send an authorization grant
// (installations plan, P3, slice 3): the MCP server's own /oauth/callback. The
// page POSTs a one-time code there, so this is security policy, decided on the
// server (the consent page asks; /api/oauth/grant enforces), never shipped to
// the browser.
//
// - Without a profile: today's patterns, unchanged: any graffiticode.org host,
//   Cloud Run (*.run.app, for tagged revisions) and local development.
// - With a profile: the installation's MCP and issuer origins over https, and
//   local development only outside production.
import type { Profile } from "./profile/schema.js";
import type { InstallationHosts } from "./profile/hosts.js";

const BUILT_IN_PATTERNS = [
  /^https:\/\/[^/]*\.graffiticode\.org(\/|$)/,
  /^https:\/\/graffiticode\.org(\/|$)/,
  /^https:\/\/[^/]*\.run\.app(\/|$)/,
  /^http:\/\/localhost(:\d+)?(\/|$)/,
  /^http:\/\/127\.0\.0\.1(:\d+)?(\/|$)/,
];

const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function oauthCallbackAllowed(url: unknown, profile: Profile | null, hosts: InstallationHosts, env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof url !== "string" || url.length > 2048) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  if (!profile) return BUILT_IN_PATTERNS.some(p => p.test(url));
  const origin = parsed.origin;
  if (LOCAL.test(origin)) return env.NODE_ENV !== "production";
  if (parsed.protocol !== "https:") return false;
  return [hosts.mcp, hosts.issuer].some(h => new URL(h).origin === origin);
}
