// External outcomes for service jobs (A2A design §4.3; execution observation
// plan, W6). Pure: no I/O. The job's external outcome says what happened at the
// provider, and is derived only from evidence the backend has settled. It is
// never derived from a timeout, a deadline or a failed request.
//
// An effect is one backend operation, identified by (execution, stage,
// occurrence). Its current status comes from that operation's settled
// evidence, updated by reconciliation or by the repair ledger. A command's
// aggregate outcome never classifies an individual effect.

// Where an execution lives. Legacy invocations have no command record, and
// none is ever manufactured for them (plan D-5).
export type ExecutionRef =
  | { protocol: "command"; commandId: string }
  | { protocol: "legacy"; invocationId: string };

export const executionRefKey = (ref: ExecutionRef) =>
  ref.protocol === "command" ? `command:${ref.commandId}` : `legacy:${ref.invocationId}`;

// Policy's per-operation outcomes (graffiticode packages/policy/src/command-outcomes.ts).
export type OperationOutcome = "completed" | "failed" | "partial" | "uncertain";

// Settled evidence for one effect, as the backend reports it.
export type EffectEvidence = {
  execution: ExecutionRef;
  stage: string;
  occurrence: string;
  // The operation's own recorded outcome; "pending" until Policy settles it.
  recorded: OperationOutcome | "pending";
  // Linked reconciliation evidence: the provider was read back, and the
  // requested state is (or isn't) there. Supersedes `recorded`.
  reconciled?: "applied" | "not_applied";
  // The repair ledger's entry for (original command, stage, occurrence): its
  // current outcome across the original and every repair. Supersedes `recorded`.
  ledger?: OperationOutcome | "pending";
  // The target already satisfied the requested state; nothing needed writing.
  alreadySatisfied?: boolean;
};

export type EffectStatus = "applied" | "partially_applied" | "not_applied" | "unresolved" | "pending";

export type ExternalOutcome = "not_requested" | "pending" | "not_started" | "applied" | "partially_applied" | "unknown";

const STATUS_OF: Record<OperationOutcome | "pending", EffectStatus> = {
  completed: "applied",
  partial: "partially_applied",
  failed: "not_applied",
  uncertain: "unresolved",
  pending: "pending",
};

// The effect's current status. The ledger and reconciliation each supersede
// the original recorded outcome, which stays in history. When both exist, the
// ledger wins: it is the record that later repairs keep current.
export function effectStatus(e: EffectEvidence): EffectStatus {
  if (e.ledger) return STATUS_OF[e.ledger];
  if (e.reconciled) return e.reconciled === "applied" ? "applied" : "not_applied";
  if (e.alreadySatisfied && e.recorded !== "pending") return "applied";
  return STATUS_OF[e.recorded];
}

// The aggregation table in A2A design §4.3, applied in order. `requested`
// is false when the job asked for no external effect at all.
export function aggregateExternalOutcome(effects: EffectEvidence[], { requested = true } = {}): ExternalOutcome {
  if (!requested) return "not_requested";
  if (effects.length === 0) return "not_started";
  const statuses = effects.map(effectStatus);
  if (statuses.includes("pending")) return "pending";
  if (statuses.includes("unresolved")) return "unknown";
  if (statuses.every(s => s === "not_applied")) return "not_started";
  if (statuses.every(s => s === "applied")) return "applied";
  return "partially_applied";
}

// For results and status: what is known to be applied, even when the overall
// outcome is `unknown`, and which targets were already satisfied.
export function summarizeEffects(effects: EffectEvidence[]) {
  const by: Record<EffectStatus, EffectEvidence[]> = {
    applied: [], partially_applied: [], not_applied: [], unresolved: [], pending: [],
  };
  for (const e of effects) by[effectStatus(e)].push(e);
  return {
    applied: by.applied.filter(e => !e.alreadySatisfied),
    alreadySatisfied: by.applied.filter(e => e.alreadySatisfied),
    partiallyApplied: by.partially_applied,
    notApplied: by.not_applied,
    unresolved: by.unresolved,
    pending: by.pending,
  };
}
