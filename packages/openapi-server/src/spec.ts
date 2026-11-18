// openapi.yaml is the source of truth: it is served as-is (with the public
// server URL), and request validation is compiled from it.
import { readFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { copy, installationHosts, profile } from "@graffiticode-app/core/profile/runtime";

const SPEC_URL = new URL("../openapi.yaml", import.meta.url);

export function loadSpec(): any {
  return parse(readFileSync(SPEC_URL, "utf8"));
}

// The URL clients reach this API at (servers[0].url), e.g.
// https://openapi.graffiticode.org/v1.
// The REST resource, which is also the advertised server URL, so servers[] and
// the OAuth resource can't disagree (core/src/profile/hosts.ts: the profile, or
// OPENAPI_PUBLIC_URL / OPENAPI_RESOURCE without one).
export const publicBase = () => installationHosts().openapiResource;

// Whether this API takes OAuth access tokens: only when the installation
// declares it as a resource (core/src/profile/hosts.ts). Otherwise nothing
// advertises OAuth: no flows or security alternatives in the description, no
// resource metadata, and no metadata pointer in a challenge.
export const restOAuthEnabled = () => installationHosts().resources.includes(publicBase());

// The description without its OAuth scheme, and without it among any
// operation's alternatives.
function withoutOAuth(spec: any) {
  const drop = (security: any) =>
    Array.isArray(security) ? security.filter((alt: any) => !(alt && typeof alt === "object" && "oauth2" in alt)) : security;
  const { oauth2: _dropped, ...schemes } = spec.components?.securitySchemes ?? {};
  const paths = Object.fromEntries(Object.entries(spec.paths ?? {}).map(([path, item]: [string, any]) => [
    path,
    Object.fromEntries(Object.entries(item ?? {}).map(([k, op]: [string, any]) =>
      [k, op && typeof op === "object" && "security" in op ? { ...op, security: drop(op.security) } : op])),
  ]));
  return { ...spec, security: drop(spec.security), paths, components: { ...spec.components, securitySchemes: schemes } };
}

// The API's title, from the profile (copy key openapi.info.title).
export const apiTitle = () => copy("openapi.info.title") ?? "Graffiticode API";

// The description as served: the public server URL, and with an installation
// profile, the installation's identity (info) and its authorization server.
// The paths, schemas and validation are the platform's and never change.
export function servedSpec(spec: any) {
  if (!restOAuthEnabled()) spec = withoutOAuth(spec);
  const served = { ...spec, servers: [{ url: publicBase() }] };
  // The OAuth flow URLs, in both modes: the same resolution as servers[] and
  // the resource metadata, so a staging server never advertises production's
  // authorization server.
  const oauth2 = spec.components?.securitySchemes?.oauth2;
  if (oauth2) {
    const resource = publicBase();
    const issuer = installationHosts().issuer;
    const flow = oauth2.flows.authorizationCode;
    served.components = {
      ...spec.components,
      securitySchemes: {
        ...spec.components.securitySchemes,
        oauth2: {
          ...oauth2,
          flows: {
            ...oauth2.flows,
            authorizationCode: {
              ...flow,
              authorizationUrl: `${issuer}/oauth/authorize?resource=${encodeURIComponent(resource)}`,
              tokenUrl: `${issuer}/oauth/token`,
              refreshUrl: `${issuer}/oauth/token`,
            },
          },
        },
      },
    };
  }
  const p = profile();
  if (!p) return served;
  served.info = {
    ...spec.info,
    title: apiTitle(),
    summary: copy("openapi.info.summary") ?? spec.info.summary,
    description: copy("openapi.info.description") ?? spec.info.description,
    contact: { name: p.brand.name, url: p.brand.links?.product ?? p.hosts.console },
  };
  // The OAuth prose is the profile's copy.
  if (oauth2) {
    const s = served.components.securitySchemes;
    s.oauth2 = { ...s.oauth2, description: copy("openapi.oauth2.description") ?? oauth2.description };
  }
  return served;
}

export const asYaml = (spec: any) => stringify(spec);
