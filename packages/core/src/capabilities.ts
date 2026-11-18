// The capability registry (installations plan, P1 and P4). A capability is
// an implementation this codebase provides. Its facts (whether it exists,
// whether it writes to a provider, what authorization it needs, what it can
// deliver) are declared here, in code, and never by a profile: a profile can
// only select capabilities and parameterize them.
//
// P1 registered the facts. P4 adds each capability's operations (what a tool
// for it can ask: a code-owned input schema) and, in capability-handlers.ts,
// the handlers that run them. A profile names a capability and may choose
// which of its operations its skill exposes, and under what tool names; it
// can't change what an operation does, what it needs, or who may call it.

import type { DeliverableKind, DeliveryState } from "./service-registry.js";

export type CapabilityAuthorization =
  // A signed-in account of the installation.
  | "account"
  // An account with an authorized provider connection.
  | "connection";

export type OperationId = "create" | "revise";

export type CapabilityOperation = {
  op: OperationId;
  // What the operation does, for a tool's description (the skill's own
  // description comes first).
  summary: string;
  // The tool's input, excluding idempotency_key, which every job tool takes.
  inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[] };
};

export type Capability = {
  id: string;
  description: string;
  implemented: boolean;
  // Writes to a provider (an item bank, a data store).
  externalWrites: boolean;
  // Needs backend execution (commands or runs), not just generation.
  requiresExecution: boolean;
  authorization: CapabilityAuthorization;
  deliverables: { kind: DeliverableKind; states: DeliveryState[] }[];
  // What a tool for it can do. Empty for a capability without handlers.
  operations: CapabilityOperation[];
};

const CREATE: CapabilityOperation = {
  op: "create",
  summary: "Starts a job that makes it from a description, and validates the result.",
  inputSchema: {
    type: "object",
    properties: { description: { type: "string", minLength: 1, description: "What to make." } },
    required: ["description"],
  },
};
const REVISE: CapabilityOperation = {
  op: "revise",
  summary: "Starts a job that revises an existing item, and validates the new revision.",
  inputSchema: {
    type: "object",
    properties: {
      item_id: { type: "string", minLength: 1, description: "The item to revise (item_id from a completed job)." },
      modification: { type: "string", minLength: 1, description: "The change to make." },
    },
    required: ["item_id", "modification"],
  },
};

// Whether backend execution is available to installations in this release.
// It becomes true when the execution prerequisites ship (plan D-3, D-5); a
// profile can't turn it on.
export const EXECUTION_READY = false;

const CAPABILITIES: Capability[] = [
  {
    id: "generate-content",
    description: "Generate or revise content in a selected language, write-free, and validate it.",
    implemented: true,
    externalWrites: false,
    requiresExecution: false,
    authorization: "account",
    deliverables: [
      { kind: "content", states: ["prepared", "previewed"] },
      { kind: "integration_recipe", states: ["prepared"] },
      { kind: "data_plan", states: ["planned"] },
    ],
    operations: [CREATE, REVISE],
  },
  {
    id: "save-revision",
    description: "Save a selected, validated revision through an authorized connection.",
    implemented: false,
    externalWrites: true,
    requiresExecution: true,
    authorization: "connection",
    deliverables: [{ kind: "content", states: ["saved"] }],
    operations: [],
  },
  {
    id: "query-records",
    description: "Run a bounded read against a provider.",
    implemented: false,
    externalWrites: false,
    requiresExecution: true,
    authorization: "connection",
    deliverables: [{ kind: "operation_result", states: ["applied"] }],
    operations: [],
  },
  {
    id: "export-records",
    description: "Export provider records.",
    implemented: false,
    externalWrites: false,
    requiresExecution: true,
    authorization: "connection",
    deliverables: [{ kind: "operation_result", states: ["exported"] }],
    operations: [],
  },
  {
    id: "migrate-records",
    description: "Transform and write provider records.",
    implemented: false,
    externalWrites: true,
    requiresExecution: true,
    authorization: "connection",
    deliverables: [{ kind: "operation_result", states: ["applied"] }],
    operations: [],
  },
];

const BY_ID = new Map(CAPABILITIES.map(c => [c.id, c]));

export function capability(id: string): Capability | null {
  return BY_ID.get(id) ?? null;
}

export function listCapabilities(): Capability[] {
  return [...CAPABILITIES];
}

// Capabilities an operator has withdrawn from this deployment (a safety kill
// switch, never a profile setting): CAPABILITIES_WITHDRAWN, comma-separated
// ids. A withdrawn capability starts no new step: its tools leave the catalog,
// new jobs are refused, and a job with no step in flight ends failed
// (capability-withdrawn). Work already in flight still settles, and job_get
// and job_cancel keep working (service-runner.ts).
export function withdrawnCapabilities(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env.CAPABILITIES_WITHDRAWN ?? "").split(",").map(s => s.trim()).filter(Boolean));
}

export function operation(c: Capability, op: string): CapabilityOperation | null {
  return c.operations.find(o => o.op === op) ?? null;
}

// Why a capability can't be selected in this release, or null if it can.
export function capabilityRefusal(c: Capability, { executionReady = EXECUTION_READY } = {}): string | null {
  if (!c.implemented) return "not implemented in this release";
  if (c.requiresExecution && !executionReady) return "needs backend execution, which this release doesn't provide";
  if (c.externalWrites && !executionReady) return "writes to a provider, which this release doesn't allow";
  return null;
}
