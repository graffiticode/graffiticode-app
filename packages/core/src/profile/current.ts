// The installation profile this process runs with (installations plan, P1).
// A server loads it once at startup (load.ts) and installs it here; modules
// read it when they need a value, never at import. Browser-safe: no node
// imports, so client code can hold the public subset served from /config.
import type { Profile } from "./schema.js";

export type InstalledProfile = { profile: Profile; digest: string };

// Process-wide, not module-wide: a bundler may give each server bundle its
// own copy of this module (the console's Next build inlines core into its
// chunks), and every copy must see the one installation the process loaded.
const SLOT = Symbol.for("graffiticode-app.installed-profile");
type Slot = { installed: InstalledProfile | null };
const slot = ((globalThis as any)[SLOT] ??= { installed: null }) as Slot;

export function setInstalledProfile(p: InstalledProfile | null) {
  slot.installed = p;
}

// The profile, or null when this process runs without one (no PROFILE_DIR).
//
// Fails closed: when PROFILE_DIR is set but nothing is installed in this
// module instance (a server bundle that never initialized, say), reading the
// profile throws rather than letting the caller fall back to built-in policy.
export function installedProfile(): InstalledProfile | null {
  const installed = slot.installed;
  if (!installed && typeof process !== "undefined" && process.env?.PROFILE_DIR) {
    throw new Error("PROFILE_DIR is set, but no installation profile is installed here. Initialize the installation (ensureInstallation) before policy-dependent work.");
  }
  return installed;
}

export function requireInstalledProfile(): InstalledProfile {
  const installed = slot.installed;
  if (!installed) throw new Error("No installation profile is installed. Load one at startup (PROFILE_DIR).");
  return installed;
}
