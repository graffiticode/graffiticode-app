// Building the public configuration for /api/config (installations plan, P3,
// slice 2). Every field is chosen here, from the installation: nothing passes
// through from the profile or the environment unlisted. See public-config.ts
// for the contract and why each value is safe for a browser.
import { PUBLIC_CONFIG_VERSION, type FirebaseWebConfig, type PublicConfig } from "./public-config.js";
import { installationHosts, profile } from "./runtime.js";
import { installationBrand } from "./brand.js";
import { selectLanguages } from "../lib/languages.js";
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
  const links = p?.brand.links ?? { product: "https://graffiticode.org", forum: "https://forum.graffiticode.org", source: "https://github.com/graffiticode", signup: brand.signupUrl };
  return {
    configVersion: PUBLIC_CONFIG_VERSION,
    installation: { id: brand.id },
    brand: {
      name: brand.name,
      links: Object.fromEntries((["product", "docs", "forum", "source", "signup"] as const).filter(k => links[k]).map(k => [k, links[k]])),
    },
    hosts: { console: hosts.console, app: hosts.app, api: hosts.api, auth: hosts.auth, mcp: hosts.mcp, languageServer: hosts.languageServer },
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
      // The languages this installation offers, under its policy.
      languages: selectLanguages().map(l => ({
        id: l.id,
        name: l.name,
        description: l.description,
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
