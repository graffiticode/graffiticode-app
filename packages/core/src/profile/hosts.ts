// Public hosts and OAuth resources for this installation (installations plan,
// P2). One resolver, called at use time (never at import), after the profile
// is loaded, so every surface agrees on where the installation lives.
//
// Precedence, tested in core/test/hosts.test.ts:
//   - Without a profile: each public host comes from its environment variable,
//     else the built-in Graffiticode default. This is today's behavior.
//   - With a profile: public hosts come from the profile. An environment
//     variable naming a public host may repeat the profile's value (deploy.json
//     sets several today), but a different value is an error: it is never
//     silently overridden, in either direction.
//   - Internal wiring is not a public host and stays environment-driven, in
//     both modes: the console's internal API endpoint (GRAFFITICODE_CONSOLE_URL),
//     and the widget's asset origin (WIDGET_ASSET_ORIGIN), which a proof
//     revision on a tagged URL points at itself while its OAuth metadata stays
//     production's (mcp-server/src/widget/index.ts).
// Two environment variables naming the same host must agree in either mode.
//
// Consistency (both modes): each OAuth resource sits on its own server's
// origin, and the REST resource is the REST server's public base. Until the
// authorization server is separated from the MCP server (plan P5), the issuer
// must be the MCP host, because that server serves /oauth/*.
//
// Browser-safe: no node imports.
import type { Profile } from "./schema.js";

export type InstallationHosts = {
  mcp: string;
  console: string;
  app: string;
  api: string;
  auth: string;
  openapi: string;
  widgetAssets: string;
  // A language server's origin, with {id} for the four-digit language id.
  languageServer: string;
  // The authorization server (today, the MCP server).
  issuer: string;
  // OAuth protected resources; tokens are bound to these.
  mcpResource: string;
  openapiResource: string;
  // Internal wiring, not a public host: where this server calls the console's API.
  consoleApi: string;
};

type Env = Record<string, string | undefined>;

export class HostConfigError extends Error {
  constructor(message: string) {
    super(`Installation host configuration: ${message}`);
    this.name = "HostConfigError";
  }
}

const DEFAULTS = {
  mcp: "https://mcp.graffiticode.org",
  console: "https://console.graffiticode.org",
  app: "https://app.graffiticode.org",
  api: "https://api.graffiticode.org",
  auth: "https://auth.graffiticode.org",
  openapiResource: "https://openapi.graffiticode.org/v1",
  languageServer: "https://l{id}.graffiticode.org",
  consoleApi: "https://console.graffiticode.org/api",
};

// The environment variables that name each public value, in today's
// precedence when more than one is read.
export const PUBLIC_HOST_ENV: Record<"mcp" | "console" | "app" | "api" | "auth" | "issuer" | "openapiResource", string[]> = {
  mcp: ["MCP_SERVER_URL"],
  console: ["CONSOLE_URL", "GRAFFITICODE_CONSOLE_BASE_URL"],
  app: ["GRAFFITICODE_APP_URL"],
  api: ["GRAFFITICODE_API_URL", "NEXT_PUBLIC_GC_API_URL"],
  auth: ["GRAFFITICODE_AUTH_URL", "NEXT_PUBLIC_GC_AUTH_URL"],
  issuer: ["MCP_OAUTH_URL"],
  openapiResource: ["OPENAPI_RESOURCE", "OPENAPI_PUBLIC_URL"],
};

const wiring = (env: Env, name: string) => (env[name] ? trim(env[name]!) : null);

const trim = (u: string) => u.replace(/\/+$/, "");
const originOf = (u: string) => {
  try {
    return new URL(u).origin;
  } catch {
    throw new HostConfigError(`${JSON.stringify(u)} is not a URL`);
  }
};

// The one value the environment gives a field, or null. Two variables for the
// same field that disagree are an error.
function fromEnv(field: keyof typeof PUBLIC_HOST_ENV, env: Env): { name: string; value: string } | null {
  let found: { name: string; value: string } | null = null;
  for (const name of PUBLIC_HOST_ENV[field]) {
    const raw = env[name];
    if (!raw) continue;
    const value = trim(raw);
    if (found && found.value !== value) {
      throw new HostConfigError(`${found.name}=${found.value} and ${name}=${value} name the same host differently`);
    }
    found ??= { name, value };
  }
  return found;
}

export function resolveHosts(profile: Profile | null, env: Env): InstallationHosts {
  let hosts: InstallationHosts;
  if (!profile) {
    const pick = (field: keyof typeof PUBLIC_HOST_ENV, fallback: string) => fromEnv(field, env)?.value ?? fallback;
    // MCP_SERVER_URL (the MCP server's own setting) and MCP_OAUTH_URL (the
    // REST server's name for it) are the same server: each falls back to the
    // other, and they must agree only when both are set.
    const mcpEnv = fromEnv("mcp", env)?.value ?? null;
    const issuerEnv = fromEnv("issuer", env)?.value ?? null;
    const mcp = mcpEnv ?? issuerEnv ?? DEFAULTS.mcp;
    const openapiResource = pick("openapiResource", DEFAULTS.openapiResource);
    hosts = {
      mcp,
      console: pick("console", DEFAULTS.console),
      app: pick("app", DEFAULTS.app),
      api: pick("api", DEFAULTS.api),
      auth: pick("auth", DEFAULTS.auth),
      openapi: originOf(openapiResource),
      widgetAssets: wiring(env, "WIDGET_ASSET_ORIGIN") ?? mcp,
      languageServer: DEFAULTS.languageServer,
      issuer: issuerEnv ?? mcp,
      mcpResource: `${mcp}/mcp`,
      openapiResource,
      consoleApi: env.GRAFFITICODE_CONSOLE_URL ? trim(env.GRAFFITICODE_CONSOLE_URL) : DEFAULTS.consoleApi,
    };
  } else {
    const h = profile.hosts;
    // A profile without a REST surface still resolves a REST host, so the
    // consistency checks hold; nothing advertises it.
    const openapiHost = trim(h.openapi ?? originOf(profile.auth.resources.openapi ?? DEFAULTS.openapiResource));
    hosts = {
      mcp: trim(h.mcp),
      console: trim(h.console),
      app: trim(h.app),
      api: trim(h.api),
      auth: trim(h.auth),
      openapi: openapiHost,
      widgetAssets: wiring(env, "WIDGET_ASSET_ORIGIN") ?? trim(h.widgetAssets ?? h.mcp),
      languageServer: h.languageServer ?? DEFAULTS.languageServer,
      issuer: trim(profile.auth.issuer),
      mcpResource: trim(profile.auth.resources.mcp),
      openapiResource: trim(profile.auth.resources.openapi ?? `${openapiHost}/v1`),
      consoleApi: env.GRAFFITICODE_CONSOLE_URL ? trim(env.GRAFFITICODE_CONSOLE_URL) : `${trim(h.console)}/api`,
    };
    // The environment may repeat the profile, never contradict it.
    for (const field of Object.keys(PUBLIC_HOST_ENV) as (keyof typeof PUBLIC_HOST_ENV)[]) {
      const e = fromEnv(field, env);
      if (e && e.value !== hosts[field]) {
        throw new HostConfigError(`${e.name}=${e.value} contradicts the installation profile's ${field} (${hosts[field]}); remove it or make it match`);
      }
    }
  }
  checkConsistency(hosts);
  return hosts;
}

export function checkConsistency(h: InstallationHosts) {
  if (originOf(h.mcpResource) !== originOf(h.mcp)) {
    throw new HostConfigError(`the MCP resource ${h.mcpResource} isn't on the MCP host ${h.mcp}`);
  }
  if (originOf(h.openapiResource) !== originOf(h.openapi)) {
    throw new HostConfigError(`the REST resource ${h.openapiResource} isn't on the REST host ${h.openapi}`);
  }
  if (originOf(h.issuer) !== originOf(h.mcp)) {
    throw new HostConfigError(`the issuer ${h.issuer} must be the MCP host ${h.mcp}, which serves the authorization endpoints`);
  }
}

// A language server's origin.
export const languageServerOrigin = (h: InstallationHosts, langId: string) =>
  h.languageServer.replace("{id}", String(langId).replace(/^L/i, "").padStart(4, "0"));
