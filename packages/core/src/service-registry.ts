// Service registry (A2A design §4.1-4.2; installations plan, P4). The
// installation's services, from its profile: reviewed, versioned definitions
// that select capabilities from the registry in code (capabilities.ts). A
// tool catalog, A2A declarations and the runtime all read the same definition
// (service-catalog.ts), so a skill is advertised only when it is available.
//
// What a skill can do (whether it is implemented, writes to a provider, needs
// execution, and which authorization it requires) comes from its capability,
// never from the profile. Without a profile there are no services.
//
// Public skill ids never encode a language number. Languages are an internal
// detail of a skill and may change without changing the skill.
import { capability, capabilityRefusal, EXECUTION_READY, withdrawnCapabilities, type CapabilityAuthorization, type OperationId } from "./capabilities.js";
import { installedProfile } from "./profile/current.js";
import type { ProfileService } from "./profile/schema.js";

export type DeliverableKind = "content" | "integration_recipe" | "data_plan" | "operation_result";

// Requested delivery states per deliverable kind. Completion is judged against
// the requested state (service-completion.ts).
export type DeliveryState = "prepared" | "previewed" | "saved" | "planned" | "exported" | "applied";

export type SkillTool = { operation: OperationId; name: string };

export type SkillDefinition = {
  skillId: string;
  name: string;
  description: string;
  // The capability it selects (capabilities.ts), and that capability's facts.
  capability: string;
  deliverableKind: DeliverableKind;
  deliveryStates: DeliveryState[];
  requiresExecution: boolean;
  externalWrites: boolean;
  implemented: boolean;
  authorization: CapabilityAuthorization;
  examples: string[];
  // Internal: languages the skill may generate. Not part of any public id.
  languages: string[];
  // The operations it exposes, as tools.
  tools: SkillTool[];
};

export type ServiceLimits = {
  // Default job deadline; carried into backend admission (A2A design §6.4).
  deadlineMs: number;
  // How long a terminal job's idempotency binding is kept (plan D-1).
  retryWindowMs: number;
  maxGenerationAttempts: number;
};

export type ServiceDefinition = {
  serviceId: string;
  version: number;
  name: string;
  responsibility: string;
  exclusions: string[];
  skills: SkillDefinition[];
  limits: ServiceLimits;
};

// A profile's service, with each skill's facts taken from its capability. A
// skill naming an unknown capability is unavailable (the validator refuses
// such a profile; this never trusts that it ran).
export function definitionFromProfile(s: ProfileService): ServiceDefinition {
  return {
    serviceId: s.serviceId,
    version: s.version,
    name: s.name,
    responsibility: s.responsibility,
    exclusions: s.exclusions ?? [],
    limits: s.limits,
    skills: s.skills.map((k): SkillDefinition => {
      const c = capability(k.capability);
      return {
        skillId: k.skillId,
        name: k.name,
        description: k.description,
        capability: k.capability,
        deliverableKind: k.deliverableKind,
        deliveryStates: k.deliveryStates,
        requiresExecution: c?.requiresExecution ?? true,
        externalWrites: c?.externalWrites ?? true,
        implemented: c?.implemented ?? false,
        authorization: c?.authorization ?? "connection",
        examples: k.examples ?? [],
        languages: k.languages,
        tools: k.tools ?? (c?.operations.some(o => o.op === "create") ? [{ operation: "create", name: k.skillId }] : []),
      };
    }),
  };
}

export function listServices(): ServiceDefinition[] {
  return (installedProfile()?.profile.services ?? []).map(definitionFromProfile);
}

export function serviceDefinition(serviceId: string): ServiceDefinition | null {
  return listServices().find(d => d.serviceId === serviceId) ?? null;
}

export type SkillContext = {
  // Backend execution is ready for this deployment. Default: this release's.
  executionReady?: boolean;
  // Capabilities an operator has withdrawn. Default: CAPABILITIES_WITHDRAWN.
  withdrawn?: ReadonlySet<string>;
  // The caller is authorized to use the skill.
  authorized?: boolean;
};

// Why a skill can't start new work, or null if it can: the intersection of a
// selected skill, an implemented capability, ready dependencies, the
// operator's switch and caller authorization.
export function skillRefusal(def: ServiceDefinition, skillId: string, ctx: SkillContext = {}): string | null {
  const skill = def.skills.find(s => s.skillId === skillId);
  if (!skill) return `skill ${skillId} isn't offered by ${def.serviceId}`;
  const c = capability(skill.capability);
  if (!c) return `skill ${skillId} names an unknown capability`;
  const refusal = capabilityRefusal(c, { executionReady: ctx.executionReady ?? EXECUTION_READY });
  if (refusal) return `skill ${skillId}: its capability is ${refusal}`;
  if ((ctx.withdrawn ?? withdrawnCapabilities()).has(c.id)) return `skill ${skillId}: its capability ${c.id} has been withdrawn`;
  if (ctx.authorized === false) return `skill ${skillId} isn't available to this caller`;
  return null;
}

export const skillAvailable = (def: ServiceDefinition, skillId: string, ctx: SkillContext = {}) => skillRefusal(def, skillId, ctx) === null;

export function availableSkills(def: ServiceDefinition, ctx: SkillContext = {}): SkillDefinition[] {
  return def.skills.filter(s => skillAvailable(def, s.skillId, ctx));
}
