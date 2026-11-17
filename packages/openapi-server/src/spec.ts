// openapi.yaml is the source of truth: it is served as-is (with the public
// server URL), and request validation is compiled from it.
import { readFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { copy, profile } from "@graffiticode-app/core/profile/runtime";

const SPEC_URL = new URL("../openapi.yaml", import.meta.url);

export function loadSpec(): any {
  return parse(readFileSync(SPEC_URL, "utf8"));
}

// The URL clients reach this API at (servers[0].url), e.g.
// https://openapi.graffiticode.org/v1.
// OPENAPI_PUBLIC_URL still wins while deploy.json sets it; otherwise the
// installation profile's REST resource, otherwise the built-in default.
export const publicBase = () =>
  (process.env.OPENAPI_PUBLIC_URL || profile()?.auth.resources.openapi || "https://openapi.graffiticode.org/v1").replace(/\/$/, "");

// The API's title, from the profile (copy key openapi.info.title).
export const apiTitle = () => copy("openapi.info.title") ?? "Graffiticode API";

// The description as served: the public server URL, and with an installation
// profile, the installation's identity (info) and its authorization server.
// The paths, schemas and validation are the platform's and never change.
export function servedSpec(spec: any) {
  const served = { ...spec, servers: [{ url: publicBase() }] };
  const p = profile();
  if (!p) return served;
  served.info = {
    ...spec.info,
    title: apiTitle(),
    summary: copy("openapi.info.summary") ?? spec.info.summary,
    description: copy("openapi.info.description") ?? spec.info.description,
    contact: { name: p.brand.name, url: p.brand.links?.product ?? p.hosts.console },
  };
  const oauth2 = spec.components?.securitySchemes?.oauth2;
  if (oauth2) {
    const resource = p.auth.resources.openapi ?? publicBase();
    const flow = oauth2.flows.authorizationCode;
    served.components = {
      ...spec.components,
      securitySchemes: {
        ...spec.components.securitySchemes,
        oauth2: {
          ...oauth2,
          description: copy("openapi.oauth2.description") ?? oauth2.description,
          flows: {
            ...oauth2.flows,
            authorizationCode: {
              ...flow,
              authorizationUrl: `${p.auth.issuer}/oauth/authorize?resource=${encodeURIComponent(resource)}`,
              tokenUrl: `${p.auth.issuer}/oauth/token`,
              refreshUrl: `${p.auth.issuer}/oauth/token`,
            },
          },
        },
      },
    };
  }
  return served;
}

export const asYaml = (spec: any) => stringify(spec);
