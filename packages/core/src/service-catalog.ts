// What an installation's services look like to callers (installations plan,
// P4), all derived from the same validated definitions (service-registry.ts):
//
// - pinned definitions: the snapshot of a skill a job starts under, with its
//   digest, so the job keeps it whatever the profile later says;
// - MCP tools: one per exposed operation of each available skill, with the
//   capability's input schema (code) and the skill's own text (profile), plus
//   the shared job_get and job_cancel;
// - A2A skill declarations, from the same skills. A2A isn't served in this
//   release (surfaces.ts); the declarations exist so the card, when it is,
//   can only say what the tools do.
//
// Only available skills appear anywhere: a deselected, unimplemented,
// not-yet-executable or withdrawn skill has no tool and no declaration.
import { createHash } from "crypto";
import { capability, operation, type CapabilityAuthorization, type OperationId } from "./capabilities.js";
import { availableSkills, type ServiceDefinition, type ServiceLimits, type SkillContext, type SkillDefinition } from "./service-registry.js";

// --- pinned definitions -------------------------------------------------------

export type PinnedSkill = {
  serviceId: string;
  serviceVersion: number;
  serviceName: string;
  limits: ServiceLimits;
  skill: SkillDefinition;
  // The capability's facts when the job started.
  capability: { id: string; implemented: boolean; externalWrites: boolean; requiresExecution: boolean; authorization: CapabilityAuthorization };
};

export function canonicalJson(v: unknown): string {
  const canon = (x: any): any =>
    Array.isArray(x) ? x.map(canon)
      : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().filter(k => x[k] !== undefined).map(k => [k, canon(x[k])]))
        : x;
  return JSON.stringify(canon(v));
}

export function pinSkill(def: ServiceDefinition, skillId: string): { definition: PinnedSkill; digest: string } | null {
  const skill = def.skills.find(s => s.skillId === skillId);
  const c = skill ? capability(skill.capability) : null;
  if (!skill || !c) return null;
  const definition: PinnedSkill = {
    serviceId: def.serviceId,
    serviceVersion: def.version,
    serviceName: def.name,
    limits: def.limits,
    skill,
    capability: { id: c.id, implemented: c.implemented, externalWrites: c.externalWrites, requiresExecution: c.requiresExecution, authorization: c.authorization },
  };
  return { definition, digest: createHash("sha256").update(canonicalJson(definition)).digest("hex") };
}

// --- MCP tools ----------------------------------------------------------------

export const JOB_RESULT_SCHEMA = {
  type: "object",
  properties: {
    job_id: { type: "string" },
    service_id: { type: "string" },
    skill_id: { type: "string" },
    state: { type: "string", enum: ["accepted", "working", "input_required", "auth_required", "completed", "failed", "canceled", "rejected"] },
    terminal: { type: "boolean" },
    external_outcome: { type: "string", enum: ["not_requested", "pending", "not_started", "applied", "partially_applied", "unknown"] },
    deliverable: { type: "object", properties: { kind: { type: "string" }, requested_state: { type: "string" } }, required: ["kind", "requested_state"], additionalProperties: false },
    item_id: { type: ["string", "null"] },
    task_id: { type: ["string", "null"] },
    view_url: { type: ["string", "null"] },
    findings: { type: "array", items: { type: "string" } },
    refusal: { type: ["object", "null"], properties: { reason: { type: "string" }, message: { type: "string" } }, additionalProperties: false },
    cancel_requested: { type: "boolean" },
    summary: { type: "string" },
  },
  required: ["job_id", "state", "terminal", "external_outcome", "summary"],
  additionalProperties: false,
} as const;

const IDEMPOTENCY_KEY = {
  type: "string",
  description: "Optional. Retrying with the same key and the same request returns the same job instead of starting another. A key reused with a different request is refused.",
  minLength: 1,
  maxLength: 255,
};
const JOB_ID = { type: "string", description: "The job_id a previous call returned." };

export type ServiceTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: typeof JOB_RESULT_SCHEMA;
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  // What the tool starts. Absent for job_get and job_cancel.
  target?: { serviceId: string; skillId: string; operation: OperationId };
};

// The tools every service catalog has: they read and cancel existing jobs, so
// they never depend on what is selected now.
export const JOB_TOOL_NAMES = ["job_get", "job_cancel"] as const;

function jobTools(brandName: string): ServiceTool[] {
  return [
    {
      name: "job_get",
      title: "Get a job",
      description: "Returns a job's state, its deliverable (item and revision) once ready, and any findings. Reading a job never starts or retries work.",
      inputSchema: { type: "object", properties: { job_id: JOB_ID }, required: ["job_id"], additionalProperties: false },
      outputSchema: JOB_RESULT_SCHEMA,
      annotations: { title: "Get a job", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "job_cancel",
      title: "Cancel a job",
      description: `Cancels a job that hasn't ended. The job ends canceled and its result is discarded; nothing outside ${brandName} is affected.`,
      inputSchema: { type: "object", properties: { job_id: JOB_ID }, required: ["job_id"], additionalProperties: false },
      outputSchema: JOB_RESULT_SCHEMA,
      annotations: { title: "Cancel a job", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function skillTools(def: ServiceDefinition, skill: SkillDefinition, brandName: string): ServiceTool[] {
  const c = capability(skill.capability)!;
  return skill.tools.flatMap(t => {
    const op = operation(c, t.operation);
    if (!op) return [];
    const title = t.operation === "create" ? skill.name : `${skill.name} (revise)`;
    const writes = c.externalWrites
      ? "It may write to a provider through an authorized connection."
      : `Never writes outside ${brandName}.`;
    return [{
      name: t.name,
      title,
      description: `${skill.description} ${op.summary} Returns a job; call job_get with its job_id until the job is terminal. ${writes}`,
      inputSchema: {
        type: "object",
        properties: { ...op.inputSchema.properties, idempotency_key: IDEMPOTENCY_KEY },
        required: op.inputSchema.required,
        additionalProperties: false,
      },
      outputSchema: JOB_RESULT_SCHEMA,
      annotations: { title, readOnlyHint: false, destructiveHint: c.externalWrites, idempotentHint: false, openWorldHint: c.externalWrites },
      target: { serviceId: def.serviceId, skillId: skill.skillId, operation: t.operation },
    }];
  });
}

// The catalog for a set of services: each available skill's tools, then the
// job tools.
export function serviceTools(defs: ServiceDefinition[], brandName: string, ctx: SkillContext = {}): ServiceTool[] {
  return [...defs.flatMap(def => availableSkills(def, ctx).flatMap(s => skillTools(def, s, brandName))), ...jobTools(brandName)];
}

// --- A2A ----------------------------------------------------------------------

export type A2ASkill = { id: string; name: string; description: string; tags: string[]; examples: string[]; inputModes: string[]; outputModes: string[] };
export type A2AServiceDeclaration = { serviceId: string; version: number; name: string; description: string; skills: A2ASkill[] };

// A service's A2A declaration: its available skills, from the same definition
// its tools come from.
export function a2aDeclaration(def: ServiceDefinition, ctx: SkillContext = {}): A2AServiceDeclaration {
  return {
    serviceId: def.serviceId,
    version: def.version,
    name: def.name,
    description: def.responsibility,
    skills: availableSkills(def, ctx).map(s => ({
      id: s.skillId,
      name: s.name,
      description: s.description,
      tags: [def.serviceId, s.deliverableKind],
      examples: s.examples,
      inputModes: ["text/plain"],
      outputModes: ["application/json"],
    })),
  };
}
