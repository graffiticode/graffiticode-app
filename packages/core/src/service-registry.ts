// Service registry (A2A design §4.1-4.2; execution observation plan, W6).
// Reviewed, versioned definitions of the frontend's services. A card or tool
// catalog is generated from the same definition the runtime uses, so a skill
// is advertised only when it is actually available.
//
// Public skill ids never encode a language number. Languages are an internal
// detail of a skill and may change without changing the skill.

export type DeliverableKind = "content" | "integration_recipe" | "data_plan" | "operation_result";

// Requested delivery states per deliverable kind. Completion is judged against
// the requested state (service-completion.ts).
export type DeliveryState = "prepared" | "previewed" | "saved" | "planned" | "exported" | "applied";

export type SkillDefinition = {
  skillId: string;
  name: string;
  description: string;
  deliverableKind: DeliverableKind;
  deliveryStates: DeliveryState[];
  // Needs backend execution (a command or run), not just generation.
  requiresExecution: boolean;
  // May write to a provider. Never true for a skill reachable from the
  // write-free MCP authoring tools.
  externalWrites: boolean;
  // A handler exists in this codebase. A definition must not advertise a skill
  // merely because a planning language describes the operation.
  implemented: boolean;
  examples: string[];
  // Internal: languages the skill may generate. Not part of any public id.
  languages: string[];
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

const DAY = 24 * 60 * 60_000;

export const LEARNOSITY_AUTHORING: ServiceDefinition = {
  serviceId: "learnosity-assessment-authoring",
  version: 1,
  name: "Learnosity Assessment Authoring",
  responsibility: "Create and revise assessment content, validate it, provide previews, and (when enabled) save an explicitly selected revision through an authorized connection.",
  exclusions: ["learner delivery", "reporting", "bulk data operations", "unrestricted item bank administration"],
  limits: { deadlineMs: 45 * 60_000, retryWindowMs: 30 * DAY, maxGenerationAttempts: 3 },
  skills: [
    {
      skillId: "author_content",
      name: "Author assessment content",
      description: "Create or revise questions, scoring, feedback and activities, validated and previewable. Never writes to an item bank.",
      deliverableKind: "content",
      deliveryStates: ["prepared", "previewed"],
      requiresExecution: false,
      externalWrites: false,
      implemented: true,
      examples: ["Five multiple-choice questions on photosynthesis for grade 7, with feedback."],
      languages: ["0176"],
    },
    {
      skillId: "plan_authoring_integration",
      name: "Plan an authoring integration",
      description: "A host-neutral recipe for embedding Learnosity's authoring UI. Requires real deployment facts.",
      deliverableKind: "integration_recipe",
      deliveryStates: ["prepared"],
      requiresExecution: false,
      externalWrites: false,
      implemented: true,
      examples: ["How do I embed the item editor restricted to multiple-choice questions?"],
      languages: ["0177"],
    },
    {
      skillId: "save_revision",
      name: "Save a revision to an item bank",
      description: "Save an explicitly selected, validated revision through an authorized connection.",
      deliverableKind: "content",
      deliveryStates: ["saved"],
      requiresExecution: true,
      externalWrites: true,
      // M1b: needs service bounds (plan D-3) and the save head (D-5).
      implemented: false,
      examples: ["Save the current revision to the Science bank."],
      languages: ["0176"],
    },
  ],
};

export const LEARNOSITY_DATA: ServiceDefinition = {
  serviceId: "learnosity-data-operations",
  version: 1,
  name: "Learnosity Data Operations",
  responsibility: "Plan, and when enabled execute, bounded reads, exports, transformations and migrations of assessment records.",
  exclusions: ["content authoring", "learner delivery", "unbounded administration"],
  limits: { deadlineMs: 45 * 60_000, retryWindowMs: 30 * DAY, maxGenerationAttempts: 3 },
  skills: [
    {
      skillId: "plan_data_job",
      name: "Plan a data job",
      description: "A recipe stating the operation, prerequisites, paging, write semantics, gotchas and verification. No live provider operation occurs.",
      deliverableKind: "data_plan",
      deliveryStates: ["planned"],
      requiresExecution: false,
      externalWrites: false,
      implemented: true,
      examples: ["Plan an export of all sessions for activity X, all pages."],
      languages: ["0178"],
    },
    ...["query_records", "export_records", "migrate_records"].map((skillId): SkillDefinition => ({
      skillId,
      name: skillId.replace("_", " "),
      description: "Executes against a provider. Not yet available.",
      deliverableKind: "operation_result",
      deliveryStates: skillId === "export_records" ? ["exported"] : ["applied"],
      requiresExecution: true,
      externalWrites: skillId === "migrate_records",
      // M3: needs durable runs (plan W2-W5).
      implemented: false,
      examples: [],
      languages: ["0188"],
    })),
  ],
};

const DEFINITIONS = new Map<string, ServiceDefinition>(
  [LEARNOSITY_AUTHORING, LEARNOSITY_DATA].map(d => [d.serviceId, d]),
);

export function serviceDefinition(serviceId: string): ServiceDefinition | null {
  return DEFINITIONS.get(serviceId) ?? null;
}

export function listServices(): ServiceDefinition[] {
  return [...DEFINITIONS.values()];
}

export type SkillContext = {
  // Skills switched on by deployment configuration. Absent: every implemented skill.
  enabled?: ReadonlySet<string>;
  // Backend execution is ready for this deployment (M1b and later).
  executionReady?: boolean;
  // The caller is authorized to use the skill.
  authorized?: boolean;
};

// Skill availability is the intersection of an implemented handler, ready
// dependencies, deployment configuration and caller authorization.
export function skillAvailable(def: ServiceDefinition, skillId: string, ctx: SkillContext = {}): boolean {
  const skill = def.skills.find(s => s.skillId === skillId);
  if (!skill || !skill.implemented) return false;
  if (skill.requiresExecution && !ctx.executionReady) return false;
  if (ctx.enabled && !ctx.enabled.has(skillId)) return false;
  return ctx.authorized !== false;
}

export function availableSkills(def: ServiceDefinition, ctx: SkillContext = {}): SkillDefinition[] {
  return def.skills.filter(s => skillAvailable(def, s.skillId, ctx));
}
