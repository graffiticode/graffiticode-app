// The public configuration a browser loads at runtime (installations plan,
// P3, slice 2): /api/config on the console and the app. The browser bundles
// carry no installation's settings; they fetch these, validate them, and only
// then initialize Firebase, Privy, Stripe or anything else that depends on
// them. A failed, malformed or unsupported response stops initialization.
//
// The contract is an explicit allowlist, versioned. It carries only values a
// browser is meant to hold: hosts, the brand, the catalog and plans it shows,
// and the public client identifiers of the shared authentication service and
// of Stripe (a Firebase web config, a Privy app id, a Stripe publishable key
// are public by design). Never credentials, never security policy: the CSP
// is set by the server on each response.
//
// Shared authentication (auth.firebase, the project users sign in to) is
// separate from the installation's application storage, which a browser
// never sees.
//
// Browser-safe: no node imports. The server builds it in public-config-server.ts.

export const PUBLIC_CONFIG_VERSION = 1;
export const SUPPORTED_PUBLIC_CONFIG_VERSIONS: readonly number[] = [1];

export type FirebaseWebConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  databaseURL?: string;
  storageBucket?: string;
  messagingSenderId?: string;
  measurementId?: string;
};

export type PublicLanguage = {
  id: string;
  name: string;
  description: string;
  domains: string[];
  status?: string;
  hidden?: boolean;
  internal?: boolean;
  sponsor?: string;
  sponsorUrl?: string;
};

export type PublicPlan = {
  displayName: string;
  basePriceMonthly: number;
  basePriceAnnual: number;
  includedItems: number;
  overageRatePerItem: number;
  tier: number;
  hardCap: boolean;
  defaultCapUsd?: number;
};

export type PublicConfig = {
  configVersion: number;
  installation: { id: string };
  brand: { name: string; links: { product?: string; docs?: string; forum?: string; source?: string; signup?: string } };
  hosts: { console: string; app: string; api: string; auth: string; mcp: string; languageServer: string };
  mcp: { endpoint: string };
  auth: { firebase: FirebaseWebConfig; privyAppId: string };
  billing: { stripePublishableKey: string | null; plans: Record<string, PublicPlan> };
  catalog: { languages: PublicLanguage[] };
  freePlan: { enabled: boolean; itemTtlHours: number };
};

export type PublicConfigResult = { ok: true; config: PublicConfig } | { ok: false; error: string };

// A refusal, with the path of the first field that broke the contract.
class Refused extends Error {}
const refuse = (path: string, problem: string): never => { throw new Refused(`${path} ${problem}`); };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// An object with exactly the declared fields: required ones present, nothing
// undeclared (the allowlist is the contract; a new field is a new version).
function fields(v: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isObj(v)) refuse(path, "is missing or not an object");
  const o = v as Record<string, unknown>;
  for (const k of required) if (o[k] === undefined) refuse(`${path}.${k}`, "is missing");
  for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) refuse(`${path}.${k}`, "isn't part of the contract");
  return o;
}
function text(v: unknown, path: string, pattern?: RegExp): string {
  if (typeof v !== "string" || v.trim() === "" || v !== v.trim()) refuse(path, "isn't a non-empty string");
  if (pattern && !pattern.test(v as string)) refuse(path, `isn't in the expected form`);
  return v as string;
}
function url(v: unknown, path: string): string {
  const s = text(v, path);
  let u: URL | null = null;
  try { u = new URL(s); } catch { /* refused below */ }
  if (!u || (u.protocol !== "https:" && u.protocol !== "http:") || /\s/.test(s)) refuse(path, "isn't an http(s) URL");
  return s;
}
// A host: an origin and nothing more.
function origin(v: unknown, path: string): string {
  const s = url(v, path);
  if (new URL(s).origin !== s) refuse(path, "isn't an origin");
  return s;
}
function amount(v: unknown, path: string, { integer = false, positive = false } = {}): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || (positive && v === 0) || (integer && !Number.isInteger(v))) {
    refuse(path, `isn't a ${positive ? "positive" : "non-negative"} ${integer ? "integer" : "number"}`);
  }
  return v as number;
}
function bool(v: unknown, path: string) {
  if (typeof v !== "boolean") refuse(path, "isn't a boolean");
}
const optionally = (v: unknown, check: () => unknown) => { if (v !== undefined) check(); };

const PLAN_IDS = ["demo", "starter", "pro", "teams", "platinum"];
const LINKS = ["product", "docs", "forum", "source", "signup"] as const;
const FIREBASE_REQUIRED = ["apiKey", "authDomain", "projectId", "appId"] as const;
const FIREBASE_OPTIONAL = ["databaseURL", "storageBucket", "messagingSenderId", "measurementId"] as const;

function check(raw: unknown) {
  const c = fields(raw, "configuration", ["configVersion", "installation", "brand", "hosts", "mcp", "auth", "billing", "catalog", "freePlan"]);

  const installation = fields(c.installation, "installation", ["id"]);
  text(installation.id, "installation.id", /^[a-z0-9][a-z0-9-]*$/);

  const brand = fields(c.brand, "brand", ["name", "links"]);
  text(brand.name, "brand.name");
  const links = fields(brand.links, "brand.links", [], LINKS);
  for (const k of LINKS) optionally(links[k], () => url(links[k], `brand.links.${k}`));

  const hosts = fields(c.hosts, "hosts", ["console", "app", "api", "auth", "mcp", "languageServer"]);
  for (const h of ["console", "app", "api", "auth", "mcp"]) origin(hosts[h], `hosts.${h}`);
  const ls = text(hosts.languageServer, "hosts.languageServer");
  if (!ls.includes("{id}")) refuse("hosts.languageServer", "has no {id}");
  origin(ls.replace("{id}", "0000"), "hosts.languageServer");

  url(fields(c.mcp, "mcp", ["endpoint"]).endpoint, "mcp.endpoint");

  const auth = fields(c.auth, "auth", ["firebase", "privyAppId"]);
  const fb = fields(auth.firebase, "auth.firebase", FIREBASE_REQUIRED, FIREBASE_OPTIONAL);
  text(fb.apiKey, "auth.firebase.apiKey", /^[A-Za-z0-9_-]+$/);
  text(fb.authDomain, "auth.firebase.authDomain", /^[a-z0-9.-]+$/);
  text(fb.projectId, "auth.firebase.projectId", /^[a-z0-9-]+$/);
  text(fb.appId, "auth.firebase.appId", /^[0-9]+:[0-9]+:web:[A-Za-z0-9]+$/);
  optionally(fb.databaseURL, () => url(fb.databaseURL, "auth.firebase.databaseURL"));
  optionally(fb.storageBucket, () => text(fb.storageBucket, "auth.firebase.storageBucket", /^[a-z0-9._-]+$/));
  optionally(fb.messagingSenderId, () => text(fb.messagingSenderId, "auth.firebase.messagingSenderId", /^[0-9]+$/));
  optionally(fb.measurementId, () => text(fb.measurementId, "auth.firebase.measurementId", /^G-[A-Z0-9]+$/));
  text(auth.privyAppId, "auth.privyAppId", /^[a-z0-9]{25}$/);

  const billing = fields(c.billing, "billing", ["stripePublishableKey", "plans"]);
  if (billing.stripePublishableKey !== null) text(billing.stripePublishableKey, "billing.stripePublishableKey", /^pk_(live|test)_[A-Za-z0-9]+$/);
  const plans = fields(billing.plans, "billing.plans", [], PLAN_IDS);
  for (const [id, raw] of Object.entries(plans)) {
    const at = `billing.plans.${id}`;
    const plan = fields(raw, at, ["displayName", "basePriceMonthly", "basePriceAnnual", "includedItems", "overageRatePerItem", "tier", "hardCap"], ["defaultCapUsd"]);
    text(plan.displayName, `${at}.displayName`);
    amount(plan.basePriceMonthly, `${at}.basePriceMonthly`);
    amount(plan.basePriceAnnual, `${at}.basePriceAnnual`);
    amount(plan.includedItems, `${at}.includedItems`, { integer: true });
    amount(plan.overageRatePerItem, `${at}.overageRatePerItem`);
    amount(plan.tier, `${at}.tier`, { integer: true });
    bool(plan.hardCap, `${at}.hardCap`);
    optionally(plan.defaultCapUsd, () => amount(plan.defaultCapUsd, `${at}.defaultCapUsd`));
  }

  const catalog = fields(c.catalog, "catalog", ["languages"]);
  if (!Array.isArray(catalog.languages)) refuse("catalog.languages", "isn't a list");
  const seen = new Set<string>();
  (catalog.languages as unknown[]).forEach((raw, i) => {
    const at = `catalog.languages[${i}]`;
    const l = fields(raw, at, ["id", "name", "description", "domains"], ["status", "hidden", "internal", "sponsor", "sponsorUrl"]);
    const id = text(l.id, `${at}.id`, /^[0-9]{4}$/);
    if (seen.has(id)) refuse(`${at}.id`, "repeats another language");
    seen.add(id);
    text(l.name, `${at}.name`);
    if (typeof l.description !== "string") refuse(`${at}.description`, "isn't a string");
    if (!Array.isArray(l.domains)) refuse(`${at}.domains`, "isn't a list");
    (l.domains as unknown[]).forEach((d, j) => text(d, `${at}.domains[${j}]`));
    optionally(l.status, () => text(l.status, `${at}.status`));
    optionally(l.hidden, () => bool(l.hidden, `${at}.hidden`));
    optionally(l.internal, () => bool(l.internal, `${at}.internal`));
    optionally(l.sponsor, () => text(l.sponsor, `${at}.sponsor`));
    optionally(l.sponsorUrl, () => url(l.sponsorUrl, `${at}.sponsorUrl`));
  });

  const freePlan = fields(c.freePlan, "freePlan", ["enabled", "itemTtlHours"]);
  bool(freePlan.enabled, "freePlan.enabled");
  amount(freePlan.itemTtlHours, "freePlan.itemTtlHours", { positive: true });
}

// Validates a /api/config response body against the whole contract. Any
// problem is a refusal, never a partial config.
export function parsePublicConfig(raw: unknown): PublicConfigResult {
  if (!isObj(raw)) return { ok: false, error: "not a JSON object" };
  if (typeof raw.configVersion !== "number" || !SUPPORTED_PUBLIC_CONFIG_VERSIONS.includes(raw.configVersion)) {
    return { ok: false, error: `unsupported configuration version ${JSON.stringify(raw.configVersion)}; this build supports ${SUPPORTED_PUBLIC_CONFIG_VERSIONS.join(", ")}` };
  }
  try {
    check(raw);
  } catch (err) {
    if (err instanceof Refused) return { ok: false, error: err.message };
    throw err;
  }
  return { ok: true, config: raw as unknown as PublicConfig };
}

// Fetches and validates the configuration. Never falls back to defaults: a
// failed request, a malformed body or an unsupported version is an error the
// caller must show instead of initializing anything.
export async function loadPublicConfig(url = "/api/config", fetchImpl: typeof fetch = fetch): Promise<PublicConfigResult> {
  let res: Response;
  try {
    res = await fetchImpl(url, { cache: "no-store", headers: { accept: "application/json" } });
  } catch (err) {
    return { ok: false, error: `couldn't reach ${url}: ${(err as Error).message}` };
  }
  if (!res.ok) return { ok: false, error: `${url} answered ${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: `${url} didn't return JSON` };
  }
  return parsePublicConfig(body);
}
