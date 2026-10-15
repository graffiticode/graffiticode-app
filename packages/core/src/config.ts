// Core's configuration as one typed object (Phase 1e). Modules read it when they
// need a value, never at import, so importing core has no side effect. By
// default it is built from the environment on first use; a host (or a test)
// can supply its own with setCoreConfig().
//
// lib/api.ts also runs in the browser, so this module must stay browser-safe:
// no node imports, and the NEXT_PUBLIC_* values are read by their literal names
// below, which is what lets Next inline them into the client bundle.

const list = (raw: string | undefined) => (raw ?? "").split(",").map(s => s.trim()).filter(Boolean);

export function configFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const consoleUrl = env.CONSOLE_URL || "https://console.graffiticode.org";
  return {
    apiUrl: env.NEXT_PUBLIC_GC_API_URL || process.env.NEXT_PUBLIC_GC_API_URL || "https://api.graffiticode.org",
    authUrl: env.NEXT_PUBLIC_GC_AUTH_URL || process.env.NEXT_PUBLIC_GC_AUTH_URL || "https://auth.graffiticode.org",
    firebaseWebApiKey: env.NEXT_PUBLIC_FIREBASE_API_KEY || process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "",
    generationQueue: {
      project: env.GENERATION_QUEUE_PROJECT || env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || "graffiticode-app",
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
