// openapi.yaml is the source of truth: it is served as-is (with the public
// server URL), and request validation is compiled from it.
import { readFileSync } from "node:fs";
import { parse, stringify } from "yaml";

const SPEC_URL = new URL("../openapi.yaml", import.meta.url);

export function loadSpec(): any {
  return parse(readFileSync(SPEC_URL, "utf8"));
}

// The URL clients reach this API at (servers[0].url), e.g.
// https://openapi.graffiticode.org/v1.
export const publicBase = () => (process.env.OPENAPI_PUBLIC_URL || "https://openapi.graffiticode.org/v1").replace(/\/$/, "");

export function servedSpec(spec: any) {
  return { ...spec, servers: [{ url: publicBase() }] };
}

export const asYaml = (spec: any) => stringify(spec);
