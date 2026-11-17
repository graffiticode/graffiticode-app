// Copy templates in a profile (installations plan, P2). A template refers to
// profile values as {{dotted.path}}, for example {{hosts.console}} or
// {{brand.name}}. Rendering is strict: an unknown path, or one that isn't a
// string or number, is an error, so a typo fails at startup rather than
// shipping "{{hosts.consle}}" to users.
//
// Copy files are used verbatim, except that one trailing newline (which
// editors add) is removed.
import type { Profile } from "./schema.js";
import { SURFACE_FAMILIES } from "../surfaces.js";

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

export class TemplateError extends Error {
  constructor(public key: string, public placeholder: string) {
    super(`Copy template ${key} refers to {{${placeholder}}}, which isn't a text value of the profile.`);
    this.name = "TemplateError";
  }
}

function lookup(profile: Profile, path: string): string | null {
  let v: any = profile;
  for (const part of path.split(".")) {
    if (v == null || typeof v !== "object" || !(part in v)) return null;
    v = v[part];
  }
  return typeof v === "string" || typeof v === "number" ? String(v) : null;
}

export function stripTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

// Values derived from the profile and this release, which copy may use so
// that every surface states them the same way:
//   {{discovery.mcpEndpoint}}  the MCP endpoint serving the item tools
//   {{discovery.itemTools}}    the item tools this release advertises, in order
// Both are empty when the profile selects no available item surface: there is
// then no endpoint to advertise, and nothing falls back to a default.
export function derivedVariables(profile: Profile): Record<string, string> {
  const items = SURFACE_FAMILIES.items;
  const served = items.available && profile.surfaces.mcp.some(m => m.path === items.path && m.families.includes("items"));
  return {
    "discovery.mcpEndpoint": served ? `${profile.hosts.mcp.replace(/\/+$/, "")}${items.path}` : "",
    "discovery.itemTools": served ? items.tools.join(", ") : "",
  };
}

export function renderTemplate(key: string, template: string, profile: Profile, derived: Record<string, string> = derivedVariables(profile)): string {
  return stripTrailingNewline(template).replace(PLACEHOLDER, (_, path: string) => {
    const value = path in derived ? derived[path] : lookup(profile, path);
    if (value === null) throw new TemplateError(key, path);
    return value;
  });
}
