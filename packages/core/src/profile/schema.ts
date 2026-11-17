// The installation profile schema (installations plan, P1). A profile is an
// operator's declarative description of one installation: its brand, hosts,
// authentication boundary, catalog, services, surfaces and copy. It lives
// outside this repo, in a directory holding `profile.json` plus the files it
// references (assets, legal documents, copy templates).
//
// The schema is versioned. A profile names the version it was written for, and
// this release accepts only the versions in SUPPORTED_PROFILE_VERSIONS.
//
// What a profile can't do: declare that a capability exists, is implemented,
// is write-free or needs less authorization. Those facts come from the code
// (capabilities.ts); a profile only selects and parameterizes.

export const PROFILE_SCHEMA_VERSION = 1;
export const SUPPORTED_PROFILE_VERSIONS: readonly number[] = [1];

const id = { type: "string", pattern: "^[a-z][a-z0-9-]{1,62}$" } as const;
const origin = { type: "string", pattern: "^https?://[^/\\s]+$" } as const;
const url = { type: "string", pattern: "^https?://\\S+$" } as const;
// A file inside the profile directory: relative, no parent segments.
const file = { type: "string", pattern: "^(?!/)(?!.*(^|/)\\.\\.(/|$))[^\\s\\\\]+$" } as const;
const text = { type: "string", minLength: 1 } as const;
const strings = { type: "array", items: text } as const;
const langIds = { type: "array", uniqueItems: true, items: { type: "string", pattern: "^L?[0-9]{4}$" } } as const;

const deliverableKind = { enum: ["content", "integration_recipe", "data_plan", "operation_result"] } as const;
const deliveryState = { enum: ["prepared", "previewed", "saved", "planned", "exported", "applied"] } as const;

export const profileSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://graffiticode.org/schemas/installation-profile/v1",
  type: "object",
  additionalProperties: false,
  required: ["profileVersion", "installation", "brand", "hosts", "auth", "surfaces"],
  properties: {
    profileVersion: { type: "integer" },
    installation: {
      type: "object",
      additionalProperties: false,
      required: ["id", "production", "project", "database"],
      properties: {
        id,
        // Production installations keep their generation-protocol floor; others
        // are treated as staging (generation-protocol.ts).
        production: { type: "boolean" },
        // The GCP project holding this installation's database and queues.
        project: { type: "string", pattern: "^[a-z][a-z0-9-]{4,28}[a-z0-9]$" },
        // Its Firestore database: "(default)" or a named database. Stated, not
        // assumed, so two installations can't share one by accident.
        database: { type: "string", pattern: "^(\\(default\\)|[a-z][a-z0-9-]{2,61}[a-z0-9])$" },
      },
    },
    brand: {
      type: "object",
      additionalProperties: false,
      required: ["name", "operator", "assets", "legal"],
      properties: {
        name: text,
        tagline: text,
        operator: {
          type: "object",
          additionalProperties: false,
          required: ["name", "url"],
          properties: { name: text, url, supportEmail: { type: "string", format: "email" } },
        },
        assets: {
          type: "object",
          additionalProperties: false,
          required: ["logo", "favicon"],
          properties: { logo: file, favicon: file, icon: file },
        },
        legal: {
          type: "object",
          additionalProperties: false,
          required: ["privacy", "terms"],
          properties: { privacy: file, terms: file, about: file },
        },
        links: {
          type: "object",
          additionalProperties: false,
          properties: { product: url, docs: url, forum: url, source: url, signup: url },
        },
      },
    },
    hosts: {
      type: "object",
      additionalProperties: false,
      required: ["console", "app", "api", "auth", "mcp"],
      properties: {
        console: origin,
        app: origin,
        api: origin,
        auth: origin,
        mcp: origin,
        openapi: origin,
        widgetAssets: origin,
        // A language server's origin, with {id} for the four-digit language id.
        languageServer: { type: "string", pattern: "^https?://\\S*\\{id\\}\\S*$" },
      },
    },
    auth: {
      type: "object",
      additionalProperties: false,
      // Every installation serves browser surfaces (the console and the app),
      // and their providers initialize only from these: a profile must name
      // its own sign-in project and Privy app, never inherit Graffiticode's.
      required: ["issuer", "firebase", "privyAppId", "resources"],
      properties: {
        // The authorization server this installation delegates sign-in to.
        issuer: origin,
        // The shared authentication service's public client identifiers, which
        // browsers load from /api/config: the web config of the Firebase
        // project users sign in to (not where application data lives), and
        // the Privy app for email sign-in.
        firebase: {
          type: "object",
          additionalProperties: false,
          required: ["apiKey", "authDomain", "projectId", "appId"],
          properties: {
            apiKey: text, authDomain: text, projectId: text, appId: text,
            databaseURL: url, storageBucket: text, messagingSenderId: text, measurementId: text,
          },
        },
        privyAppId: { type: "string", pattern: "^[a-z0-9]{25}$" },
        // This installation's protected resources: tokens are bound to these.
        resources: {
          type: "object",
          additionalProperties: false,
          required: ["mcp"],
          properties: { mcp: url, openapi: url },
        },
      },
    },
    // What this installation decides about the platform's languages. What a
    // language does (its description, routing, gates, composition) is the
    // platform's and stays in code; a profile selects and sets policy.
    catalog: {
      type: "object",
      additionalProperties: false,
      properties: {
        // The languages offered: listed, discoverable and creatable. Absent:
        // every platform language. Existing items in other languages still work.
        languages: langIds,
        // Withheld from the catalog listing and the router's candidates, but
        // still usable by id.
        hidden: langIds,
        // Which offered languages list_languages, the REST catalog and the MCP
        // instructions show: those numbered minLanguage and up, plus include,
        // minus exclude. Absent: every offered language.
        discovery: {
          type: "object",
          additionalProperties: false,
          required: ["minLanguage"],
          properties: { minLanguage: { type: "integer", minimum: 0 }, include: langIds, exclude: langIds },
        },
        // Who pays for a language's items: free to the customer, and debited to
        // the sponsor's account when uid is set.
        sponsors: {
          type: "object",
          propertyNames: { pattern: "^L?[0-9]{4}$" },
          additionalProperties: {
            type: "object",
            additionalProperties: false,
            required: ["name"],
            properties: { name: text, url, uid: { type: "string", minLength: 1 } },
          },
        },
      },
    },
    services: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["serviceId", "version", "name", "responsibility", "skills", "limits"],
        properties: {
          serviceId: id,
          version: { type: "integer", minimum: 1 },
          name: text,
          responsibility: text,
          exclusions: strings,
          limits: {
            type: "object",
            additionalProperties: false,
            required: ["deadlineMs", "retryWindowMs", "maxGenerationAttempts"],
            properties: {
              deadlineMs: { type: "integer", minimum: 60_000 },
              retryWindowMs: { type: "integer", minimum: 0 },
              maxGenerationAttempts: { type: "integer", minimum: 1 },
            },
          },
          skills: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["skillId", "name", "description", "capability", "deliverableKind", "deliveryStates", "languages"],
              properties: {
                // Public; never encodes a language number.
                skillId: { type: "string", pattern: "^(?!.*[0-9]{4})[a-z][a-z0-9_]{1,62}$" },
                name: text,
                description: text,
                // A capability id from the registry in code.
                capability: id,
                deliverableKind,
                deliveryStates: { type: "array", minItems: 1, items: deliveryState },
                languages: { type: "array", minItems: 1, items: { type: "string", pattern: "^[0-9]{4}$" } },
                examples: strings,
              },
            },
          },
        },
      },
    },
    surfaces: {
      type: "object",
      additionalProperties: false,
      required: ["mcp"],
      properties: {
        mcp: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "families"],
            properties: {
              path: { type: "string", pattern: "^/[a-z0-9/_-]*$" },
              // "items": the generic item tools; "services": tools generated from services.
              families: { type: "array", minItems: 1, uniqueItems: true, items: { enum: ["items", "services"] } },
              // Which services a "services" family serves (default: all).
              services: { type: "array", items: id },
            },
          },
        },
        a2a: { type: "object", additionalProperties: false, properties: { enabled: { type: "boolean" } } },
        rest: { type: "object", additionalProperties: false, properties: { enabled: { type: "boolean" } } },
      },
    },
    // An agent-app listing (the OpenAI plugin): its fixed fields. The prose is
    // copy (listing.longDescription, listing.defaultPrompts).
    listing: {
      type: "object",
      additionalProperties: false,
      required: ["pluginName", "displayName", "shortDescription", "category", "author", "supportUrl"],
      properties: {
        // The id the app directory assigned.
        pluginName: { type: "string", minLength: 1, maxLength: 64 },
        displayName: { type: "string", minLength: 1, maxLength: 30 },
        shortDescription: { type: "string", minLength: 1, maxLength: 30 },
        category: { enum: ["Productivity", "Education", "Developer Tools", "Business", "Creative", "Lifestyle", "Research"] },
        author: { type: "object", additionalProperties: false, required: ["name", "url"], properties: { name: text, url } },
        supportUrl: url,
      },
    },
    // Copy templates by key (server instructions, tool descriptions, ...), as files.
    copy: { type: "object", additionalProperties: file },
    // Commercial terms per plan. Plans, their tiers and Stripe wiring are code
    // (core/src/lib/plans-config.ts); a profile may only state each plan's
    // terms, and, until different terms are enabled in a release, only the
    // terms the code already has (profile/validate.ts).
    billing: {
      type: "object",
      additionalProperties: false,
      properties: {
        // Stripe's publishable key (public by design), for the browser's payment form.
        stripePublishableKey: { type: "string", pattern: "^pk_(live|test)_[A-Za-z0-9]+$" },
        plans: {
          type: "object",
          propertyNames: { enum: ["demo", "starter", "pro", "teams", "platinum"] },
          additionalProperties: {
            type: "object",
            additionalProperties: false,
            properties: {
              displayName: text,
              basePriceMonthly: { type: "number", minimum: 0 },
              basePriceAnnual: { type: "number", minimum: 0 },
              includedItems: { type: "integer", minimum: 0 },
              overageRatePerItem: { type: "number", minimum: 0 },
              defaultCapUsd: { type: "number", minimum: 0 },
            },
          },
        },
      },
    },
    freePlan: {
      type: "object",
      additionalProperties: false,
      required: ["enabled"],
      properties: {
        enabled: { type: "boolean" },
        itemTtlHours: { type: "integer", minimum: 1 },
        // The languages an anonymous caller may create. Absent: every offered language.
        languages: langIds,
      },
    },
    csp: {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: { mode: { enum: ["report-only", "enforce"] } },
    },
  },
} as const;

export type DeliverableKindName = "content" | "integration_recipe" | "data_plan" | "operation_result";
export type DeliveryStateName = "prepared" | "previewed" | "saved" | "planned" | "exported" | "applied";

export type ProfileSkill = {
  skillId: string;
  name: string;
  description: string;
  capability: string;
  deliverableKind: DeliverableKindName;
  deliveryStates: DeliveryStateName[];
  languages: string[];
  examples?: string[];
};

export type ProfileService = {
  serviceId: string;
  version: number;
  name: string;
  responsibility: string;
  exclusions?: string[];
  limits: { deadlineMs: number; retryWindowMs: number; maxGenerationAttempts: number };
  skills: ProfileSkill[];
};

export type Profile = {
  profileVersion: number;
  installation: { id: string; production: boolean; project: string; database: string };
  brand: {
    name: string;
    tagline?: string;
    operator: { name: string; url: string; supportEmail?: string };
    assets: { logo: string; favicon: string; icon?: string };
    legal: { privacy: string; terms: string; about?: string };
    links?: { product?: string; docs?: string; forum?: string; source?: string; signup?: string };
  };
  hosts: {
    console: string; app: string; api: string; auth: string; mcp: string;
    openapi?: string; widgetAssets?: string; languageServer?: string;
  };
  auth: {
    issuer: string;
    firebase: { apiKey: string; authDomain: string; projectId: string; appId: string; databaseURL?: string; storageBucket?: string; messagingSenderId?: string; measurementId?: string };
    privyAppId: string;
    resources: { mcp: string; openapi?: string };
  };
  catalog?: {
    languages?: string[];
    hidden?: string[];
    discovery?: { minLanguage: number; include?: string[]; exclude?: string[] };
    sponsors?: Record<string, { name: string; url?: string; uid?: string }>;
  };
  services?: ProfileService[];
  surfaces: {
    mcp: { path: string; families: ("items" | "services")[]; services?: string[] }[];
    a2a?: { enabled?: boolean };
    rest?: { enabled?: boolean };
  };
  listing?: {
    pluginName: string;
    displayName: string;
    shortDescription: string;
    category: string;
    author: { name: string; url: string };
    supportUrl: string;
  };
  copy?: Record<string, string>;
  billing?: {
    stripePublishableKey?: string;
    plans?: Partial<Record<"demo" | "starter" | "pro" | "teams" | "platinum", {
      displayName?: string; basePriceMonthly?: number; basePriceAnnual?: number;
      includedItems?: number; overageRatePerItem?: number; defaultCapUsd?: number;
    }>>;
  };
  freePlan?: { enabled: boolean; itemTtlHours?: number; languages?: string[] };
  csp?: { mode: "report-only" | "enforce" };
};
