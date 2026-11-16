// Completion validators (A2A design §4.2, §9, §10; execution observation
// plan, W6). Pure: no I/O. They decide whether a service's completion
// contract is met for the requested delivery state. They never change the
// external outcome: a validation failure fails the service while keeping what
// was actually written.

import type { CompletionVerdict } from "./service-job-state.js";
import type { DeliverableKind, DeliveryState } from "./service-registry.js";
import type { ExternalOutcome } from "./service-outcomes.js";

export type Check = { name: string; passed: boolean; blocking: boolean; message?: string };

export type CompletionEvidence = {
  deliverableKind: DeliverableKind;
  requestedState: DeliveryState;
  // The selected revision (content) or recipe/plan task.
  taskId?: string;
  itemId?: string;
  // Machine checks run against the deliverable (structure, references, scoring).
  checks: Check[];
  previewAvailable?: boolean;
  // A recipe or plan states that no live provider operation occurred.
  statesNoLiveOperation?: boolean;
  externalOutcome: ExternalOutcome;
  // The request explicitly permits defined exclusions (A2A design §10.3).
  permitsExclusions?: boolean;
  // Saved-content and operation evidence: provider references were returned
  // and, where supported, read back.
  providerReferences?: string[];
  readBackVerified?: boolean;
};

const verdict = (findings: string[]): CompletionVerdict => ({ met: findings.length === 0, findings });

function failedChecks(e: CompletionEvidence): string[] {
  return e.checks.filter(c => c.blocking && !c.passed).map(c => `check failed: ${c.name}${c.message ? ` (${c.message})` : ""}`);
}

function prepared(e: CompletionEvidence): string[] {
  const findings = failedChecks(e);
  if (!e.taskId) findings.push("no selected revision");
  return findings;
}

// Writes are judged only on settled evidence; `pending` or `unknown` never
// completes a delivery state that requires a write.
function written(e: CompletionEvidence): string[] {
  const findings: string[] = [];
  if (e.externalOutcome === "applied") {
    if (!e.providerReferences?.length) findings.push("no provider references returned");
  } else if (e.externalOutcome === "partially_applied" && e.permitsExclusions) {
    // Permitted exclusions: complete, with the exceptions reported.
  } else {
    findings.push(`external outcome is ${e.externalOutcome}`);
  }
  return findings;
}

const VALIDATORS: Record<DeliverableKind, (e: CompletionEvidence) => string[]> = {
  content: e => {
    const findings = prepared(e);
    if (e.requestedState === "previewed" && !e.previewAvailable) findings.push("no usable preview");
    if (e.requestedState === "saved") {
      findings.push(...written(e));
    } else if (e.externalOutcome !== "not_requested") {
      // Preparing or previewing content never writes (A2A design §5).
      findings.push(`unexpected external outcome ${e.externalOutcome} for ${e.requestedState} content`);
    }
    return findings;
  },
  integration_recipe: e => {
    const findings = prepared(e);
    if (e.externalOutcome !== "not_requested") findings.push(`unexpected external outcome ${e.externalOutcome} for a recipe`);
    return findings;
  },
  data_plan: e => {
    const findings = prepared(e);
    if (!e.statesNoLiveOperation) findings.push("plan does not state that no live operation occurred");
    if (e.externalOutcome !== "not_requested") findings.push(`unexpected external outcome ${e.externalOutcome} for a plan`);
    return findings;
  },
  operation_result: e => {
    const findings = failedChecks(e);
    findings.push(...written(e));
    if (e.externalOutcome === "applied" && e.readBackVerified === false) findings.push("read-back did not verify the result");
    return findings;
  },
};

export function validateCompletion(e: CompletionEvidence): CompletionVerdict {
  return verdict(VALIDATORS[e.deliverableKind](e));
}
