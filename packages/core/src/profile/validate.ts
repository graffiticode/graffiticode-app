// Profile validation (installations plan, P1). Three layers, all reported
// together so an operator sees every problem at once:
//   1. the JSON Schema for the profile's version;
//   2. consistency inside the profile (ids, references, resources on hosts);
//   3. the profile against the capability registry in code: a skill may only
//      select a capability this release implements and allows, for a
//      deliverable that capability actually produces.
// File checks are injected (`fileExists`) so this module does no I/O itself.
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { capability, capabilityRefusal, EXECUTION_READY } from "../capabilities.js";
import { platformLanguageById } from "../lib/languages.js";
import { SURFACE_FAMILIES, type SurfaceFamily } from "../surfaces.js";
import { profileSchema, SUPPORTED_PROFILE_VERSIONS, type Profile } from "./schema.js";

export type ProfileProblem = { path: string; message: string };

export type ValidateOptions = {
  // Checks that a file named by the profile exists in its directory.
  fileExists?: (relativePath: string) => boolean;
  executionReady?: boolean;
};

let compiled: any = null;
function schemaValidator() {
  if (!compiled) {
    const ajv = new (Ajv2020 as any).default({ allErrors: true, strict: true, allowUnionTypes: true });
    (addFormats as any).default(ajv);
    compiled = ajv.compile(profileSchema);
  }
  return compiled;
}

const normLang = (l: string) => l.replace(/^L/i, "");

// The files a profile refers to, with where it refers to them.
export function referencedFiles(p: Profile): { path: string; file: string }[] {
  const out: { path: string; file: string }[] = [];
  for (const [k, v] of Object.entries(p.brand?.assets ?? {})) if (v) out.push({ path: `/brand/assets/${k}`, file: v });
  for (const [k, v] of Object.entries(p.brand?.legal ?? {})) if (v) out.push({ path: `/brand/legal/${k}`, file: v });
  for (const [k, v] of Object.entries(p.copy ?? {})) out.push({ path: `/copy/${k}`, file: v });
  return out;
}

export function validateProfile(raw: unknown, opts: ValidateOptions = {}): { ok: boolean; problems: ProfileProblem[]; profile: Profile | null } {
  const problems: ProfileProblem[] = [];
  const version = (raw as any)?.profileVersion;
  if (!SUPPORTED_PROFILE_VERSIONS.includes(version)) {
    problems.push({ path: "/profileVersion", message: `unsupported profile version ${JSON.stringify(version)}; this release supports ${SUPPORTED_PROFILE_VERSIONS.join(", ")}` });
    return { ok: false, problems, profile: null };
  }
  const validate = schemaValidator();
  if (!validate(raw)) {
    for (const e of validate.errors ?? []) {
      const extra = e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : "";
      problems.push({ path: e.instancePath || "/", message: `${e.message}${extra}` });
    }
    return { ok: false, problems, profile: null };
  }
  const p = raw as Profile;
  const executionReady = opts.executionReady ?? EXECUTION_READY;

  // Resources must belong to this installation's own hosts: same origin,
  // compared as parsed URLs, never as string prefixes.
  const originOf = (u: string) => { try { return new URL(u).origin; } catch { return null; } };
  const onHost = (resource: string, host: string) => originOf(resource) !== null && originOf(resource) === originOf(host);
  if (!onHost(p.auth.resources.mcp, p.hosts.mcp)) {
    problems.push({ path: "/auth/resources/mcp", message: `must be on the installation's mcp host ${p.hosts.mcp}` });
  }
  if (p.auth.resources.openapi) {
    if (!p.hosts.openapi) problems.push({ path: "/auth/resources/openapi", message: "needs hosts.openapi" });
    else if (!onHost(p.auth.resources.openapi, p.hosts.openapi)) {
      problems.push({ path: "/auth/resources/openapi", message: `must be on the installation's openapi host ${p.hosts.openapi}` });
    }
  }

  // Services and their skills.
  const catalog = p.catalog?.languages ? new Set(p.catalog.languages.map(normLang)) : null;
  const serviceIds = new Set<string>();
  (p.services ?? []).forEach((s, i) => {
    const at = `/services/${i}`;
    if (serviceIds.has(s.serviceId)) problems.push({ path: `${at}/serviceId`, message: `duplicate service ${s.serviceId}` });
    serviceIds.add(s.serviceId);
    const skillIds = new Set<string>();
    s.skills.forEach((k, j) => {
      const sat = `${at}/skills/${j}`;
      if (skillIds.has(k.skillId)) problems.push({ path: `${sat}/skillId`, message: `duplicate skill ${k.skillId}` });
      skillIds.add(k.skillId);
      const c = capability(k.capability);
      if (!c) {
        problems.push({ path: `${sat}/capability`, message: `unknown capability ${k.capability}` });
        return;
      }
      const refusal = capabilityRefusal(c, { executionReady });
      if (refusal) problems.push({ path: `${sat}/capability`, message: `capability ${c.id} can't be selected: ${refusal}` });
      const produces = c.deliverables.find(d => d.kind === k.deliverableKind);
      if (!produces) {
        problems.push({ path: `${sat}/deliverableKind`, message: `capability ${c.id} doesn't deliver ${k.deliverableKind}` });
      } else {
        for (const st of k.deliveryStates) {
          if (!produces.states.includes(st)) problems.push({ path: `${sat}/deliveryStates`, message: `capability ${c.id} can't deliver ${k.deliverableKind} as ${st}` });
        }
      }
      if (catalog) {
        for (const l of k.languages) if (!catalog.has(l)) problems.push({ path: `${sat}/languages`, message: `language ${l} isn't in this installation's catalog` });
      }
    });
  });

  // Catalog policy: every id must be a language this release knows, and every
  // policy must be about a language the installation offers.
  const lists: [string, string[] | undefined][] = [
    ["/catalog/languages", p.catalog?.languages],
    ["/catalog/hidden", p.catalog?.hidden],
    ["/catalog/discovery/include", p.catalog?.discovery?.include],
    ["/catalog/discovery/exclude", p.catalog?.discovery?.exclude],
    ["/catalog/sponsors", Object.keys(p.catalog?.sponsors ?? {})],
    ["/freePlan/languages", p.freePlan?.languages],
  ];
  for (const [path, ids] of lists) {
    for (const raw of ids ?? []) {
      const l = normLang(raw);
      if (!platformLanguageById(l)) problems.push({ path, message: `unknown language L${l}` });
      else if (catalog && path !== "/catalog/languages" && !catalog.has(l)) {
        problems.push({ path, message: `L${l} isn't offered by this installation (catalog.languages)` });
      }
    }
  }

  // Surfaces. This release serves each available family at one fixed path, and
  // always serves the item tools there: a profile must say so, and can't move
  // them, or discovery would advertise an endpoint the server doesn't answer.
  const items = SURFACE_FAMILIES.items;
  if (!p.surfaces.mcp.some(m => m.path === items.path && m.families.includes("items"))) {
    problems.push({ path: "/surfaces/mcp", message: `this release serves the item tools at ${items.path}; select the "items" family there` });
  }
  p.surfaces.mcp.forEach((m, i) => {
    for (const f of m.families as SurfaceFamily[]) {
      const family = SURFACE_FAMILIES[f];
      if (family.available && m.path !== family.path) {
        problems.push({ path: `/surfaces/mcp/${i}/path`, message: `this release serves the ${f} family only at ${family.path}, not ${m.path}` });
      }
    }
  });
  const paths = new Set<string>();
  p.surfaces.mcp.forEach((m, i) => {
    const at = `/surfaces/mcp/${i}`;
    if (paths.has(m.path)) problems.push({ path: `${at}/path`, message: `duplicate path ${m.path}` });
    paths.add(m.path);
    const servesServices = m.families.includes("services");
    if (m.services && !servesServices) problems.push({ path: `${at}/services`, message: "listed services need the \"services\" family" });
    if (servesServices && serviceIds.size === 0) problems.push({ path: `${at}/families`, message: "the \"services\" family needs at least one service" });
    for (const sid of m.services ?? []) {
      if (!serviceIds.has(sid)) problems.push({ path: `${at}/services`, message: `unknown service ${sid}` });
    }
  });

  // Referenced files.
  if (opts.fileExists) {
    for (const r of referencedFiles(p)) {
      if (!opts.fileExists(r.file)) problems.push({ path: r.path, message: `file not found: ${r.file}` });
    }
  }

  return { ok: problems.length === 0, problems, profile: problems.length === 0 ? p : null };
}
