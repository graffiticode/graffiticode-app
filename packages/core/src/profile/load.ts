// Loading an installation profile from its directory (installations plan,
// P1). Node only. The profile directory is the unit an operator versions and
// gc-deploy mounts: `profile.json` plus every file it references.
//
// The digest covers every file in the directory (path and content), so a
// release can record exactly which profile it ran with, alongside the app
// version (profileReceipt).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Profile } from "./schema.js";
import { validateProfile, type ProfileProblem } from "./validate.js";

export const PROFILE_FILE = "profile.json";

export class ProfileError extends Error {
  constructor(public dir: string, public problems: ProfileProblem[]) {
    super(`Invalid installation profile at ${dir}:\n${problems.map(p => `  ${p.path}: ${p.message}`).join("\n")}`);
    this.name = "ProfileError";
  }
}

export type LoadedProfile = {
  profile: Profile;
  dir: string;
  // sha256 over the canonical manifest of every file (profileDigest).
  digest: string;
  // Reads a file the profile references, as text or bytes.
  readText(relativePath: string): string;
  readBytes(relativePath: string): Uint8Array;
};

// A version-control directory is not part of the profile: it is never hashed
// and can never be referenced.
const EXCLUDED_DIRS = new Set([".git"]);

// Lists every file in the profile, hidden ones included: everything the loader
// can serve is covered by the digest. Symlinks are not supported anywhere in a
// profile, because a link's target can change without the profile changing.
function listFiles(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    const rel = relative(root, full).split(sep).join("/");
    if (e.isSymbolicLink()) throw new ProfileError(root, [{ path: `/${rel}`, message: "symlinks aren't supported in a profile" }]);
    if (e.isDirectory()) {
      if (dir === root && EXCLUDED_DIRS.has(e.name)) continue;
      out.push(...listFiles(root, full));
    } else if (e.isFile()) {
      out.push(rel);
    } else {
      throw new ProfileError(root, [{ path: `/${rel}`, message: "only regular files are supported in a profile" }]);
    }
  }
  return out.sort();
}

// The digest: sha256 over a canonical manifest, a JSON array of
// [path, sha256(content)] in sorted path order. JSON encoding keeps different
// layouts from producing the same hashed input.
export function profileDigest(dir: string): string {
  const root = realpathSync(resolve(dir));
  const manifest = listFiles(root).map(rel => [rel, createHash("sha256").update(readFileSync(join(root, rel))).digest("hex")]);
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

// Resolves a profile-relative path to a regular file inside the profile, or
// null. The profile has no symlinks (listFiles), so containment is a path check.
function inside(root: string, files: ReadonlySet<string>, rel: string): string | null {
  const target = resolve(root, rel);
  if (!target.startsWith(root + sep)) return null;
  const norm = relative(root, target).split(sep).join("/");
  return files.has(norm) ? target : null;
}

export function loadProfile(dir: string, opts: { executionReady?: boolean } = {}): LoadedProfile {
  let root: string;
  try {
    root = realpathSync(resolve(dir));
  } catch {
    throw new ProfileError(dir, [{ path: "/", message: "profile directory not found" }]);
  }
  // Lists (and so checks) the whole directory first: no symlinks, no special
  // files. Every later read, profile.json included, goes through this list.
  const files = new Set(listFiles(root));
  const entry = inside(root, files, PROFILE_FILE);
  if (!entry) throw new ProfileError(dir, [{ path: "/", message: `${PROFILE_FILE} not found` }]);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(entry, "utf8"));
  } catch (err) {
    throw new ProfileError(dir, [{ path: "/", message: `can't read ${PROFILE_FILE}: ${(err as Error).message}` }]);
  }
  const result = validateProfile(raw, { ...opts, fileExists: rel => inside(root, files, rel) !== null });
  if (!result.ok) throw new ProfileError(dir, result.problems);
  return {
    profile: result.profile!,
    dir: root,
    digest: profileDigest(root),
    readText(rel: string) {
      const real = inside(root, files, rel);
      if (!real) throw new Error(`Profile file not found: ${rel}`);
      return readFileSync(real, "utf8");
    },
    readBytes(rel: string) {
      const real = inside(root, files, rel);
      if (!real) throw new Error(`Profile file not found: ${rel}`);
      return readFileSync(real);
    },
  };
}

// What a release records about the profile it runs with.
export function profileReceipt(loaded: LoadedProfile, release: { appVersion: string; profileRepo?: string; profileRef?: string }) {
  return {
    appVersion: release.appVersion,
    installationId: loaded.profile.installation.id,
    profileVersion: loaded.profile.profileVersion,
    profileRepo: release.profileRepo ?? null,
    profileRef: release.profileRef ?? null,
    profileDigest: loaded.digest,
  };
}
