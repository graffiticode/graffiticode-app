// The capability registry (installations plan, P1 and P4). A capability is
// an implementation this codebase provides. Its facts (whether it exists,
// whether it writes to a provider, what authorization it needs, what it can
// deliver) are declared here, in code, and never by a profile: a profile can
// only select capabilities and parameterize them.
//
// P1 registers facts only; handlers attach in P4.

import type { DeliverableKind, DeliveryState } from "./service-registry.js";

export type CapabilityAuthorization =
  // A signed-in account of the installation.
  | "account"
  // An account with an authorized provider connection.
  | "connection";

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
  },
  {
    id: "save-revision",
    description: "Save a selected, validated revision through an authorized connection.",
    implemented: false,
    externalWrites: true,
    requiresExecution: true,
    authorization: "connection",
    deliverables: [{ kind: "content", states: ["saved"] }],
  },
  {
    id: "query-records",
    description: "Run a bounded read against a provider.",
    implemented: false,
    externalWrites: false,
    requiresExecution: true,
    authorization: "connection",
    deliverables: [{ kind: "operation_result", states: ["applied"] }],
  },
  {
    id: "export-records",
    description: "Export provider records.",
    implemented: false,
    externalWrites: false,
    requiresExecution: true,
    authorization: "connection",
    deliverables: [{ kind: "operation_result", states: ["exported"] }],
  },
  {
    id: "migrate-records",
    description: "Transform and write provider records.",
    implemented: false,
    externalWrites: true,
    requiresExecution: true,
    authorization: "connection",
    deliverables: [{ kind: "operation_result", states: ["applied"] }],
  },
];

const BY_ID = new Map(CAPABILITIES.map(c => [c.id, c]));

export function capability(id: string): Capability | null {
  return BY_ID.get(id) ?? null;
}

export function listCapabilities(): Capability[] {
  return [...CAPABILITIES];
}

// Why a capability can't be selected in this release, or null if it can.
export function capabilityRefusal(c: Capability, { executionReady = EXECUTION_READY } = {}): string | null {
  if (!c.implemented) return "not implemented in this release";
  if (c.requiresExecution && !executionReady) return "needs backend execution, which this release doesn't provide";
  if (c.externalWrites && !executionReady) return "writes to a provider, which this release doesn't allow";
  return null;
}
