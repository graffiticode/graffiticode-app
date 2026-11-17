// The installation profile this process runs with (installations plan, P1).
// A server loads it once at startup (load.ts) and installs it here; modules
// read it when they need a value, never at import. Browser-safe: no node
// imports, so client code can hold the public subset served from /config.
import type { Profile } from "./schema.js";

export type InstalledProfile = { profile: Profile; digest: string };

let installed: InstalledProfile | null = null;

export function setInstalledProfile(p: InstalledProfile | null) {
  installed = p;
}

// The profile, or null before one is installed. Until P2 wires every surface
// to it, callers fall back to today's behavior when it is null.
export function installedProfile(): InstalledProfile | null {
  return installed;
}

export function requireInstalledProfile(): InstalledProfile {
  if (!installed) throw new Error("No installation profile is installed. Load one at startup (PROFILE_DIR).");
  return installed;
}
