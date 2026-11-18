// Core's configuration as one typed object (Phase 1e). Modules read it when they
// need a value, never at import, so importing core has no side effect. By
// default it is built from the environment on first use; a host (or a test)
// can supply its own with setCoreConfig().
//
// lib/api.ts also runs in the browser, so this module must stay browser-safe:
// no node imports, and the NEXT_PUBLIC_* values are read by their literal names
// below, which is what lets Next inline them into the client bundle.

import { installedProfile } from "./profile/current.js";
import { resolveHosts } from "./profile/hosts.js";
import type { PublicConfig } from "./profile/public-config.js";
import { storageProjectOrNull } from "./profile/storage-config.js";

const list = (raw: string | undefined) => (raw ?? "").split(",").map(s => s.trim()).filter(Boolean);

export function configFromEnv(env: NodeJS.ProcessEnv = process.env) {
  // A browser has no environment of its own to read: what a bundle could see
  // is a build-time value, which would bake one installation into a bundle
  // every installation shares. Its configuration comes from the installation's
  // public configuration instead (configFromPublic, set by the page's
  // configuration gate). Until then, nothing in a browser may resolve a host.
  if (typeof window !== "undefined") {
    throw new Error("core's configuration in a browser comes from the installation's public configuration (/api/config), which hasn't loaded");
  }
  // Public hosts from the one resolver (profile/hosts.ts), in both modes, so core
  // and the servers' installationHosts() always agree. The resolver sees only
  // `env`, the runtime environment, whose variables are checked against the
  // profile: a value Next inlined into the server bundle at build time isn't
  // the server's environment.
  const installed = installedProfile();
  const hosts = resolveHosts(installed?.profile ?? null, env);
  const consoleUrl = hosts.console;
  return {
    apiUrl: hosts.api,
    authUrl: hosts.auth,
    firebaseWebApiKey: env.NEXT_PUBLIC_FIREBASE_API_KEY || process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "",
    generationQueue: {
      // The installation's project unless the queue lives elsewhere; never a
      // built-in project (profile/storage-config.ts).
      project: env.GENERATION_QUEUE_PROJECT || storageProjectOrNull(installed?.profile ?? null, env) || "",
      location: env.GENERATION_QUEUE_LOCATION || "us-central1",
      name: env.GENERATION_QUEUE_NAME || "generation-jobs",
      secret: env.INTERNAL_JOB_SECRET || "",
      consoleUrl,
      workerUrl: env.GENERATION_JOB_URL || `${consoleUrl}/api/generate-job`,
      local: env.GENERATION_QUEUE_LOCAL === "1",
    },
    alerts: {
      sendgridApiKey: env.SENDGRID_API_KEY || "",
      emailFrom: env.ALERT_EMAIL_FROM || "",
      twilioAccountSid: env.TWILIO_ACCOUNT_SID || "",
      twilioAuthToken: env.TWILIO_AUTH_TOKEN || "",
      twilioFrom: env.TWILIO_FROM || "",
      smsTo: env.ALERT_SMS_TO || "",
    },
    funnel: {
      excludeSessions: list(env.FUNNEL_EXCLUDE_SESSIONS),
      internalNamespaces: list(env.FUNNEL_INTERNAL_NAMESPACES),
      internalToken: env.FUNNEL_INTERNAL_TOKEN ?? "",
    },
    // Acting as a user for generation jobs and their effects (act-as.ts).
    actAs: {
      grantSecret: env.ACT_AS_GRANT_SECRET || "",
      audience: env.ACT_AS_AUDIENCE || "urn:graffiticode:auth",
    },
    // Generation protocol this revision produces (1 or 2); see generation-protocol.ts.
    generationProtocol: env.GENERATION_PROTOCOL === "v2" || env.GENERATION_PROTOCOL === "2" ? 2 : 1,
    ragDebug: !!env.RAG_DEBUG,
    judgeMaxTokens: parseInt(env.JUDGE_MAX_TOKENS || "8192", 10),
    // The RAG fallback's example files. Phase 2 points this at the core package.
    trainingDir: typeof process.cwd === "function" ? `${process.cwd()}/training` : "training",
  };
}

export type CoreConfig = ReturnType<typeof configFromEnv>;

// Core's configuration in a browser, from the installation's validated public
// configuration: its public hosts and the shared sign-in project's web key.
// Everything server-only (queues, secrets, alerts) is empty: a browser never
// has it.
export function configFromPublic(pc: PublicConfig): CoreConfig {
  return {
    apiUrl: pc.hosts.api,
    authUrl: pc.hosts.auth,
    firebaseWebApiKey: pc.auth.firebase.apiKey,
    generationQueue: { project: "", location: "", name: "", secret: "", consoleUrl: pc.hosts.console, workerUrl: "", local: false },
    alerts: { sendgridApiKey: "", emailFrom: "", twilioAccountSid: "", twilioAuthToken: "", twilioFrom: "", smsTo: "" },
    funnel: { excludeSessions: [], internalNamespaces: [], internalToken: "" },
    actAs: { grantSecret: "", audience: "" },
    generationProtocol: 1,
    ragDebug: false,
    judgeMaxTokens: 8192,
    trainingDir: "training",
  };
}

let current: CoreConfig | null = null;

export function coreConfig(): CoreConfig {
  current ??= configFromEnv();
  return current;
}

// Replaces the configuration (null returns to reading the environment on next use).
export function setCoreConfig(config: CoreConfig | null) {
  current = config;
}
