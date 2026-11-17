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
import { storageProjectOrNull } from "./profile/storage-config.js";

const list = (raw: string | undefined) => (raw ?? "").split(",").map(s => s.trim()).filter(Boolean);

export function configFromEnv(env: NodeJS.ProcessEnv = process.env) {
  // Public hosts from the one resolver (profile/hosts.ts), in both modes, so core
  // and the servers' installationHosts() always agree.
  //
  // The literal process.env.NEXT_PUBLIC_* reads are the browser's only way to
  // see those values: Next inlines a literal read at build time. So they're
  // used in the browser alone. On a server, Next inlines them too, into the
  // server bundle, and a value baked in at build time isn't the server's
  // environment: passed to the resolver it would contradict an installation
  // profile naming other hosts. The server resolver sees only `env`, the
  // runtime environment, whose variables are still checked against the profile.
  const installed = installedProfile();
  const inBrowser = typeof window !== "undefined";
  const hosts = resolveHosts(installed?.profile ?? null, inBrowser
    ? {
      ...env,
      NEXT_PUBLIC_GC_API_URL: env.NEXT_PUBLIC_GC_API_URL || process.env.NEXT_PUBLIC_GC_API_URL,
      NEXT_PUBLIC_GC_AUTH_URL: env.NEXT_PUBLIC_GC_AUTH_URL || process.env.NEXT_PUBLIC_GC_AUTH_URL,
    }
    : env);
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

let current: CoreConfig | null = null;

export function coreConfig(): CoreConfig {
  current ??= configFromEnv();
  return current;
}

// Replaces the configuration (null returns to reading the environment on next use).
export function setCoreConfig(config: CoreConfig | null) {
  current = config;
}
