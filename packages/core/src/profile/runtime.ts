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
import { resolveHosts, type InstallationHosts } from "./hosts.js";
import { resolveStorage, type InstallationStorage } from "./storage-config.js";
import { setCoreConfig } from "../config.js";
import { checkAsset, type AssetKind, type CheckedAsset } from "./assets.js";
import { securityHeaders, encodeSecurityHeaders, SECURITY_HEADERS_ENV, type HeaderPair, type Surface } from "./security-headers.js";
import { resolve as resolvePath } from "node:path";

// Process-wide state (see current.ts): every module instance of core in the
// process shares the one loaded installation.
type RuntimeState = {
  loaded: LoadedProfile | null;
  rendered: Map<string, string>;
  receipt: ReturnType<typeof profileReceipt> | null;
  hostsMemo: InstallationHosts | null;
  storageMemo: InstallationStorage | null;
  // The directory the profile was loaded from: pinned for the process's life.
  pinnedDir: string | null;
  // The brand images, read and checked at load (profile/assets.ts).
  assets: Map<AssetKind, CheckedAsset>;
};
const STATE = Symbol.for("graffiticode-app.installation-runtime");
const state = ((globalThis as any)[STATE] ??= { loaded: null, rendered: new Map(), receipt: null, hostsMemo: null, storageMemo: null, pinnedDir: null, assets: new Map() }) as RuntimeState;
state.assets ??= new Map();

// `requireStorage`: whether this process uses application storage, so a
// missing or contradicting project stops the start (true unless the server
// never touches Firestore, like the MCP server outside core mode).
export function loadInstallation(env: NodeJS.ProcessEnv = process.env, { requireStorage = true }: { requireStorage?: boolean } = {}) {
  if (!env.PROFILE_DIR) {
    // No profile: still check the environment's hosts and storage now, so a
    // conflict or a missing project stops the start rather than a request.
    resolveHosts(null, env);
    if (requireStorage) resolveStorage(null, env);
    return null;
  }
  const l = loadProfile(env.PROFILE_DIR);
  state.pinnedDir = resolvePath(env.PROFILE_DIR);
  // Resolved once, after loading: a contradicting environment variable or an
  // inconsistent resource stops the start (profile/hosts.ts).
  const hosts = resolveHosts(l.profile, env);
  // And where its data lives: a contradicting project or database stops the start.
  const storage = resolveStorage(l.profile, env);
  const copy = new Map<string, string>();
  for (const [key, file] of Object.entries(l.profile.copy ?? {})) {
    copy.set(key, renderTemplate(key, l.readText(file), l.profile));
  }
  // The brand images: read once and kept, so what is served is what the
  // digest covered, whatever happens to the files later.
  const assets = new Map<AssetKind, CheckedAsset>();
  for (const [kind, file] of Object.entries(l.profile.brand.assets) as [AssetKind, string][]) {
    const checked = checkAsset(kind, l.readBytes(file));
    if ("problem" in checked) throw new Error(`Installation profile: brand.assets.${kind}: ${file} ${checked.problem}`);
    assets.set(kind, checked);
  }
  state.loaded = l;
  state.rendered = copy;
  state.assets = assets;
  state.hostsMemo = hosts;
  state.storageMemo = storage;
  setInstalledProfile({ profile: l.profile, digest: l.digest });
  // Core's configuration reads hosts from the installed profile; rebuild it.
  setCoreConfig(null);
  state.receipt = profileReceipt(l, { appVersion: env.K_REVISION || env.APP_VERSION || "dev", profileRepo: env.PROFILE_REPO, profileRef: env.PROFILE_REF });
  return state.receipt;
}

// What this process reports about the profile it runs with, or null.
export function installationReceipt() {
  return state.receipt;
}

// For tests.
export function resetInstallation() {
  state.loaded = null;
  state.rendered = new Map();
  state.receipt = null;
  state.hostsMemo = null;
  state.storageMemo = null;
  state.pinnedDir = null;
  state.assets = new Map();
  setInstalledProfile(null);
  setCoreConfig(null);
}

export function profile(): Profile | null {
  return state.loaded?.profile ?? null;
}

// A rendered copy template, or null when there's no profile or no such key.
export function copy(key: string): string | null {
  return state.rendered.get(key) ?? null;
}

// A profile file's bytes (an asset), or null without a profile.
export function profileFile(relativePath: string): Uint8Array | null {
  return state.loaded ? state.loaded.readBytes(relativePath) : null;
}

// The security headers this installation's documents carry on a surface
// (profile/security-headers.ts), from the pinned profile and its hosts.
export function installationSecurityHeaders(surface: Surface): HeaderPair[] {
  return securityHeaders(surface, profile(), installationHosts());
}

// For a Next server's startup: computes the surface's headers from the pinned
// installation and hands them to its middleware (edge runtime) through the
// process environment, always overwriting whatever was there.
export function publishSecurityHeaders(surface: Surface, env: NodeJS.ProcessEnv = process.env) {
  env[SECURITY_HEADERS_ENV] = encodeSecurityHeaders(installationSecurityHeaders(surface));
}

// A brand image as loaded and checked at startup, or null without a profile.
export function installationAsset(kind: AssetKind): CheckedAsset | null {
  return state.loaded ? state.assets.get(kind) ?? null : null;
}

// A legal or about document, verbatim (one trailing newline removed).
export function document(kind: "privacy" | "terms" | "about"): string | null {
  const file = state.loaded?.profile.brand.legal[kind];
  return file ? stripTrailingNewline(state.loaded!.readText(file)) : null;
}

// Where this installation lives: public hosts and OAuth resources, resolved at
// use time. With a profile they're fixed at load; without one they follow the
// environment, read on each call (profile/hosts.ts).
export function installationHosts(env: NodeJS.ProcessEnv = process.env): InstallationHosts {
  if (state.loaded) return (state.hostsMemo ??= resolveHosts(state.loaded.profile, env));
  failClosed(env);
  return resolveHosts(null, env);
}

// With PROFILE_DIR set, nothing may be resolved from the environment before
// the profile is loaded: that would pick the wrong hosts or the wrong database
// and could be cached by whoever asked.
function failClosed(env: NodeJS.ProcessEnv) {
  if (env.PROFILE_DIR) {
    throw new Error("PROFILE_DIR is set, but the installation isn't initialized here. Initialize it (ensureInstallation) before using hosts or storage.");
  }
}

// Idempotent initialization, for entry points that can't rely on startup
// having run in their module instance (a server bundle, a worker). With
// PROFILE_DIR set: loads the profile once and reuses it for the process's
// life, never re-reading files; a different PROFILE_DIR later is an error. A
// failed load throws, so the caller fails closed. Without PROFILE_DIR: checks
// the environment's hosts and returns null.
export function ensureInstallation(env: NodeJS.ProcessEnv = process.env, { requireStorage = true }: { requireStorage?: boolean } = {}) {
  const dir = env.PROFILE_DIR;
  if (!dir) {
    if (!state.loaded) {
      resolveHosts(null, env);
      if (requireStorage) resolveStorage(null, env);
    }
    return null;
  }
  if (state.loaded) {
    if (state.pinnedDir !== resolvePath(dir)) {
      throw new Error(`The installation was loaded from ${state.pinnedDir}; PROFILE_DIR is now ${dir}. Restart to change installations.`);
    }
    return state.receipt;
  }
  return loadInstallation(env, { requireStorage });
}

// Where this installation's application data lives. With a profile it's fixed
// at load; without one it follows the environment, and a missing project is an
// error (profile/storage-config.ts).
export function installationStorage(env: NodeJS.ProcessEnv = process.env): InstallationStorage {
  if (state.loaded) return (state.storageMemo ??= resolveStorage(state.loaded.profile, env));
  failClosed(env);
  return resolveStorage(null, env);
}
