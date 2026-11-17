// The installation a server process runs as (installations plan, P2). With
// PROFILE_DIR set, the profile is loaded and validated once at startup, every
// copy template is rendered (so a bad one fails the start, not a request), and
// the surfaces below read from it. Without PROFILE_DIR, every accessor returns
// null and callers keep their built-in Graffiticode behavior, unchanged until
// gc-deploy mounts profiles (docs/installations-plan.md, tracked items).
import { loadProfile, profileReceipt, type LoadedProfile } from "./load.js";
import { setInstalledProfile } from "./current.js";
import { renderTemplate, stripTrailingNewline } from "./template.js";
import type { Profile } from "./schema.js";

let loaded: LoadedProfile | null = null;
let rendered = new Map<string, string>();
let receipt: ReturnType<typeof profileReceipt> | null = null;

export function loadInstallation(env: NodeJS.ProcessEnv = process.env) {
  if (!env.PROFILE_DIR) return null;
  const l = loadProfile(env.PROFILE_DIR);
  const copy = new Map<string, string>();
  for (const [key, file] of Object.entries(l.profile.copy ?? {})) {
    copy.set(key, renderTemplate(key, l.readText(file), l.profile));
  }
  loaded = l;
  rendered = copy;
  setInstalledProfile({ profile: l.profile, digest: l.digest });
  receipt = profileReceipt(l, { appVersion: env.K_REVISION || env.APP_VERSION || "dev", profileRepo: env.PROFILE_REPO, profileRef: env.PROFILE_REF });
  return receipt;
}

// What this process reports about the profile it runs with, or null.
export function installationReceipt() {
  return receipt;
}

// For tests.
export function resetInstallation() {
  loaded = null;
  rendered = new Map();
  receipt = null;
  setInstalledProfile(null);
}

export function profile(): Profile | null {
  return loaded?.profile ?? null;
}

// A rendered copy template, or null when there's no profile or no such key.
export function copy(key: string): string | null {
  return rendered.get(key) ?? null;
}

// A legal or about document, verbatim (one trailing newline removed).
export function document(kind: "privacy" | "terms" | "about"): string | null {
  const file = loaded?.profile.brand.legal[kind];
  return file ? stripTrailingNewline(loaded!.readText(file)) : null;
}
