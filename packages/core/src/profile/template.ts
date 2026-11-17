// Copy templates in a profile (installations plan, P2). A template refers to
// profile values as {{dotted.path}}, for example {{hosts.console}} or
// {{brand.name}}. Rendering is strict: an unknown path, or one that isn't a
// string or number, is an error, so a typo fails at startup rather than
// shipping "{{hosts.consle}}" to users.
//
// Copy files are used verbatim, except that one trailing newline (which
// editors add) is removed.
import type { Profile } from "./schema.js";

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

export function renderTemplate(key: string, template: string, profile: Profile): string {
  return stripTrailingNewline(template).replace(PLACEHOLDER, (_, path: string) => {
    const value = lookup(profile, path);
    if (value === null) throw new TemplateError(key, path);
    return value;
  });
}
