// Building the public configuration for /api/config (installations plan, P3,
// slice 2). Every field is chosen here, from the installation: nothing passes
// through from the profile or the environment unlisted. See public-config.ts
// for the contract and why each value is safe for a browser.
import { PUBLIC_CONFIG_VERSION, type FirebaseWebConfig, type PublicConfig } from "./public-config.js";
import { copy, installationHosts, profile } from "./runtime.js";
import { installationBrand } from "./brand.js";
import { isLanguageOffered, resolvableLanguages } from "../lib/languages.js";
import { plans } from "../lib/plans-config.js";
import { freePlanEnabled, freePlanItemTtlHours } from "../lib/free-plan-context.js";

// The shared authentication project's web config, for the built-in
// (no-profile) Graffiticode installation. Users sign in to this project; it
// is not where any installation's application data lives.
export const BUILT_IN_FIREBASE_WEB_CONFIG: FirebaseWebConfig = {
  apiKey: "AIzaSyAoVuUNi8ElnS7cn6wc3D8XExML-URLw0I",
  authDomain: "graffiticode.firebaseapp.com",
  databaseURL: "https://graffiticode.firebaseio.com",
  projectId: "graffiticode",
  storageBucket: "graffiticode.appspot.com",
  messagingSenderId: "656973052505",
  appId: "1:656973052505:web:f3f3cc6397a844599c8f48",
  measurementId: "G-KRPK1CDB19",
};

// The built-in installation's Privy app (the value the Dockerfiles have baked
// into the bundles until now). The runtime image doesn't carry
// NEXT_PUBLIC_PRIVY_APP_ID, so the built-in installation can't rely on it.
// Where the platform's snapshot language (L0013) publishes item thumbnails.
// A platform location, so the default for every installation that doesn't
// name its own (hosts.thumbnails).
export const BUILT_IN_THUMBNAILS = "https://storage.googleapis.com/graffiticode.appspot.com/thumbnails";

// The built-in installation's document metadata: what the console's
// _document and the app's layout carried before slice 3.
export const BUILT_IN_CONSOLE_METADATA = { title: "Console", description: "Graffiticode - A software studio" };

const bare = (u: string) => u.replace(/^https?:\/\//, "");

// Each surface's title and description: the profile's copy (console.title,
// console.description, app.title, app.description), else derived from its
// brand. Without a profile, exactly today's.
function pageMetadata(p: ReturnType<typeof profile>, brandName: string, mcpEndpoint: string) {
  const own = (key: string) => copy(key)?.trim() || null;
  const appDescription = `Render ${brandName} items and tasks as forms — created via the ${brandName} MCP server at ${bare(mcpEndpoint)}`;
  if (!p) return { console: BUILT_IN_CONSOLE_METADATA, app: { title: brandName, description: appDescription } };
  return {
    console: {
      title: own("console.title") ?? `${brandName} Console`,
      description: own("console.description") ?? p.brand.tagline ?? `${brandName} Console`,
    },
    app: { title: own("app.title") ?? brandName, description: own("app.description") ?? appDescription },
  };
}

// The console's longer pages, as Markdown: the profile's copy (console.home,
// console.about), else generic text from its brand; null without a profile,
// where the pages keep today's built-in content.
function pageCopy(p: ReturnType<typeof profile>, brandName: string) {
  if (!p) return { consoleHome: null, consoleAbout: null };
  const operator = p.brand.operator;
  return {
    consoleHome: copy("console.home") ?? `# Welcome to ${brandName}\n\n${p.brand.tagline ?? ""}`.trim(),
    consoleAbout: copy("console.about") ?? `# About ${brandName}\n\n${brandName} is operated by [${operator.name}](${operator.url}).`
      + (operator.supportEmail ? ` Write to [${operator.supportEmail}](mailto:${operator.supportEmail}).` : ""),
  };
}

export const BUILT_IN_PRIVY_APP_ID = "cmom2ijrw00040cl4hd9qvjnq";

const FIREBASE_FIELDS = ["apiKey", "authDomain", "projectId", "appId", "databaseURL", "storageBucket", "messagingSenderId", "measurementId"] as const;

export class PublicConfigError extends Error {
  constructor(message: string) {
    super(`Public configuration: ${message}`);
    this.name = "PublicConfigError";
  }
}

// The browser's client identifiers. With a profile, the profile is their only
// source: nothing is inherited from the built-in installation or from the
// environment, so an installation can never initialize with Graffiticode's
// sign-in project or Privy app, and has no Stripe key unless it names one.
// Without a profile (today's Graffiticode deployment), the built-in Firebase
// config and Privy app (the environment may name the Privy app), and the
// environment's Stripe key.
function clientIds(env: NodeJS.ProcessEnv) {
  const p = profile();
  if (p) {
    if (!p.auth.firebase) throw new PublicConfigError(`the installation profile has no auth.firebase`);
    if (!p.auth.privyAppId) throw new PublicConfigError(`the installation profile has no auth.privyAppId`);
    return { firebase: p.auth.firebase as FirebaseWebConfig, privyAppId: p.auth.privyAppId, stripePublishableKey: p.billing?.stripePublishableKey ?? null };
  }
  return {
    firebase: BUILT_IN_FIREBASE_WEB_CONFIG,
    privyAppId: env.NEXT_PUBLIC_PRIVY_APP_ID || BUILT_IN_PRIVY_APP_ID,
    stripePublishableKey: env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || null,
  };
}

export function buildPublicConfig(env: NodeJS.ProcessEnv = process.env): PublicConfig {
  const p = profile();
  const hosts = installationHosts();
  const brand = installationBrand();
  const ids = clientIds(env);
  const firebase = Object.fromEntries(FIREBASE_FIELDS.filter(k => ids.firebase[k] !== undefined).map(k => [k, ids.firebase[k]])) as FirebaseWebConfig;
  const { privyAppId, stripePublishableKey } = ids;
  const links = p?.brand.links ?? {
    product: "https://graffiticode.org",
    forum: "https://forum.graffiticode.org",
    support: "https://forum.graffiticode.org/c/support/57",
    source: "https://github.com/graffiticode",
    signup: brand.signupUrl,
  };
  const supportEmail = p ? p.brand.operator.supportEmail : "support@graffiticode.org";
  return {
    configVersion: PUBLIC_CONFIG_VERSION,
    installation: { id: brand.id },
    brand: {
      name: brand.name,
      ...(supportEmail ? { supportEmail } : {}),
      links: Object.fromEntries((["product", "docs", "forum", "support", "source", "signup"] as const).filter(k => links[k]).map(k => [k, links[k]])),
    },
    hosts: {
      console: hosts.console, app: hosts.app, api: hosts.api, auth: hosts.auth, mcp: hosts.mcp, languageServer: hosts.languageServer,
      thumbnails: (p?.hosts.thumbnails ?? BUILT_IN_THUMBNAILS).replace(/\/+$/, ""),
    },
    metadata: pageMetadata(p, brand.name, hosts.mcpResource),
    copy: pageCopy(p, brand.name),
    mcp: { endpoint: hosts.mcpResource },
    auth: { firebase, privyAppId },
    billing: {
      stripePublishableKey,
      plans: Object.fromEntries(Object.entries(plans()).map(([id, plan]) => [id, {
        displayName: plan.displayName,
        basePriceMonthly: plan.basePriceMonthly,
        basePriceAnnual: plan.basePriceAnnual,
        includedItems: plan.includedItems,
        overageRatePerItem: plan.overageRatePerItem,
        tier: plan.tier,
        hardCap: plan.hardCap,
        ...(plan.defaultCapUsd !== undefined ? { defaultCapUsd: plan.defaultCapUsd } : {}),
      }])),
    },
    catalog: {
      // Every language this installation resolves, under its policy, each
      // marked whether it is offered (listed, and open to new items) or
      // resolves only for existing items.
      languages: resolvableLanguages().map(l => ({
        id: l.id,
        offered: isLanguageOffered(l.id),
        name: l.name,
        description: l.description,
        ...(l.routingHint ? { routingHint: l.routingHint } : {}),
        domains: l.domains,
        ...(l.status ? { status: l.status } : {}),
        ...(l.hidden ? { hidden: true } : {}),
        ...(l.internal ? { internal: true } : {}),
        ...(l.sponsor ? { sponsor: l.sponsor } : {}),
        ...(l.sponsorUrl ? { sponsorUrl: l.sponsorUrl } : {}),
      })),
    },
    freePlan: { enabled: freePlanEnabled(), itemTtlHours: freePlanItemTtlHours() },
  };
}
