// Where an installation keeps its application data (installations plan, P3,
// storage isolation): the GCP project and Firestore database. Pure and
// browser-safe; the handle is made in storage.ts.
//
// Explicit, never a fallback:
//   - With a profile: installation.project and installation.database. An
//     environment variable naming the project or database may repeat them,
//     never contradict them.
//   - Without one: GOOGLE_CLOUD_PROJECT (or GCLOUD_PROJECT; they must agree)
//     is required, and FIRESTORE_DATABASE_ID names the database ("(default)"
//     when unset). There is no built-in project.
//
// This is application storage only. The shared authentication project the
// browser signs in with is separate configuration (P3, /config).
import type { Profile } from "./schema.js";

export type InstallationStorage = { projectId: string; databaseId: string };

export class StorageConfigError extends Error {
  constructor(message: string) {
    super(`Installation storage: ${message}`);
    this.name = "StorageConfigError";
  }
}

type Env = Record<string, string | undefined>;

function envProject(env: Env): { name: string; value: string } | null {
  const a = env.GOOGLE_CLOUD_PROJECT, b = env.GCLOUD_PROJECT;
  if (a && b && a !== b) throw new StorageConfigError(`GOOGLE_CLOUD_PROJECT=${a} and GCLOUD_PROJECT=${b} disagree`);
  if (a) return { name: "GOOGLE_CLOUD_PROJECT", value: a };
  if (b) return { name: "GCLOUD_PROJECT", value: b };
  return null;
}

export function resolveStorage(profile: Profile | null, env: Env): InstallationStorage {
  const project = envProject(env);
  const database = env.FIRESTORE_DATABASE_ID || null;
  if (profile) {
    const s = { projectId: profile.installation.project, databaseId: profile.installation.database };
    if (project && project.value !== s.projectId) {
      throw new StorageConfigError(`${project.name}=${project.value} contradicts the installation profile's project (${s.projectId})`);
    }
    if (database && database !== s.databaseId) {
      throw new StorageConfigError(`FIRESTORE_DATABASE_ID=${database} contradicts the installation profile's database (${s.databaseId})`);
    }
    return s;
  }
  if (!project) throw new StorageConfigError("GOOGLE_CLOUD_PROJECT is required: there is no built-in project");
  return { projectId: project.value, databaseId: database ?? "(default)" };
}

// The project, or null when none is configured (for settings that only need
// to know it, like the generation queue's default project).
export function storageProjectOrNull(profile: Profile | null, env: Env): string | null {
  try {
    return resolveStorage(profile, env).projectId;
  } catch {
    return null;
  }
}
