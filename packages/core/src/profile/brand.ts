// The installation's name, as response copy uses it (installations plan, P2):
// the service a refusal comes from, its account and free plan, the connector a
// user reconnects, the name an MCP client registers the server under. Without
// a profile, Graffiticode's. Browser-safe.
//
// "Graffiticode" as the name of the language platform ("a Graffiticode
// language", the DSL, code-generation prompts) is not the installation's name
// and isn't routed through here.
import { installedProfile } from "./current.js";

export function installationBrand() {
  const p = installedProfile()?.profile;
  return {
    name: p?.brand.name ?? "Graffiticode",
    // The name an MCP client registers this server under.
    id: p?.installation.id ?? "graffiticode",
    signupUrl: (p ? p.brand.links?.signup ?? `${p.hosts.console}/signup` : "https://graffiticode.org/signup").replace(/\/+$/, ""),
  };
}

// The signup URL with attribution parameters added, keeping any query or
// fragment the installation's URL already has.
export function signupUrlWith(params: Record<string, string>, base = installationBrand().signupUrl): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

// A URL as prose shows it: no scheme.
export const displayUrl = (url: string) => url.replace(/^https?:\/\//, "");
