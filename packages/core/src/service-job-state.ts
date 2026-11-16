// Service-job state mapping (A2A design §6.3; execution observation plan,
// W6). Pure: no I/O.
//
// Three different things decide three different questions:
//   - continuation (is the job still going?): the lifecycle class of the
//     executions the job submitted;
//   - service success (completed or failed): the frontend's completion
//     validators;
//   - what happened at the provider: the external outcome (service-outcomes.ts).
// A terminal command alone decides none of these.

import { aggregateExternalOutcome, type EffectEvidence, type ExecutionRef, type ExternalOutcome } from "./service-outcomes.js";

export type JobState =
  | "accepted" | "working" | "input_required" | "auth_required"
  | "completed" | "failed" | "canceled" | "rejected";

export const TERMINAL_JOB_STATES: ReadonlySet<JobState> = new Set(["completed", "failed", "canceled", "rejected"]);
export const isTerminalJobState = (s: JobState) => TERMINAL_JOB_STATES.has(s);

export type InterruptKind = "input" | "authorization" | "reconciliation" | "dependency";
export type InterruptResolver = "user" | "administrator" | "operator";

// A backend interrupt record, as the run reports it (interpreter design §9).
export type InterruptView = {
  interruptId: string;
  revision: number;
  kind: InterruptKind;
  resolver: InterruptResolver;
  // Whether this job's caller can resolve it. Defaults to resolver === "user".
  callerCanResolve?: boolean;
};

// What the job knows about one execution it refers to.
export type ExecutionView = {
  ref: ExecutionRef;
  // Submitted by this job (owned), or adopted from the console or another job
  // (observed). A job's deadline and cancel never touch an adopted execution.
  owned: boolean;
  // Lifecycle class. An immediate command is "active" while pending and
  // "terminal" once settled. A run reports its own class.
  lifecycle: "active" | "interrupted" | "terminal";
  interrupt?: InterruptView;
  // The run ended because the caller asked it to stop.
  stopped?: boolean;
};

export type CompletionVerdict = { met: boolean; findings: string[] };

export type JobStateInput = {
  // "accepted": not started; "preparing": generation or planning, before any
  // backend command; "executing": at least one execution exists or is expected.
  phase: "accepted" | "preparing" | "executing";
  // Refused by capability preflight before anything was allocated.
  refused?: boolean;
  // A frontend clarification question is open (preparation phase).
  preparationQuestion?: boolean;
  executions: ExecutionView[];
  effects: EffectEvidence[];
  // Did the request ask for any external effect at all?
  effectsRequested: boolean;
  // The completion validators' verdict, once everything the job owns is settled.
  verdict?: CompletionVerdict;
  deadlinePassed?: boolean;
  cancelRequested?: boolean;
};

export type Blocker = { ref: ExecutionRef; interrupt: InterruptView };

export type JobStateResult = {
  state: JobState;
  externalOutcome: ExternalOutcome;
  // Ended while an adopted execution was still pending (A2A design §6.3).
  detached?: { refs: ExecutionRef[] };
  // An interrupt the caller can't resolve: the job stays working, and status
  // names the blocker and its resolver.
  blocker?: Blocker;
  // The interrupt the caller is asked to resolve.
  awaiting?: Blocker;
};

const callerCanResolve = (i: InterruptView) => i.callerCanResolve ?? i.resolver === "user";

export function deriveJobState(input: JobStateInput): JobStateResult {
  const externalOutcome = aggregateExternalOutcome(input.effects, { requested: input.effectsRequested });
  const done = (state: JobState, extra: Partial<JobStateResult> = {}): JobStateResult => ({ state, externalOutcome, ...extra });

  if (input.refused) return done("rejected");

  const owned = input.executions.filter(e => e.owned);
  const adopted = input.executions.filter(e => !e.owned);

  // Interrupts on executions the job owns.
  for (const e of owned) {
    if (e.lifecycle !== "interrupted" || !e.interrupt) continue;
    const blocker = { ref: e.ref, interrupt: e.interrupt };
    if (!callerCanResolve(e.interrupt)) return done("working", { blocker });
    return done(e.interrupt.kind === "authorization" ? "auth_required" : "input_required", { awaiting: blocker });
  }
  // The job never ends while an execution it owns is still going. The deadline
  // was carried into backend admission, so the backend stops and settles it.
  if (owned.some(e => e.lifecycle !== "terminal")) return done("working");

  if (input.preparationQuestion) return done("input_required");

  if (input.cancelRequested && owned.length > 0 && owned.every(e => e.stopped)) return done("canceled");
  if (input.cancelRequested && owned.length === 0 && adopted.length === 0) return done("canceled");

  // Observers: an adopted execution still running. The job's own deadline or
  // cancel detaches it; the shared execution is never stopped.
  const adoptedRunning = adopted.filter(e => e.lifecycle !== "terminal");
  if (adoptedRunning.length > 0) {
    if (input.deadlinePassed || input.cancelRequested) {
      return done("failed", { detached: { refs: adoptedRunning.map(e => e.ref) } });
    }
    return done("working");
  }

  // Evidence can lag the lifecycle (a settled command whose per-operation
  // evidence hasn't been read yet). A non-detached job never ends while any
  // effect is pending.
  if (externalOutcome === "pending") return done("working");

  if (input.phase === "accepted") return input.deadlinePassed ? done("failed") : done("accepted");
  if (!input.verdict) return input.deadlinePassed ? done("failed") : done("working");
  if (input.cancelRequested && !input.verdict.met) return done("canceled");
  return done(input.verdict.met ? "completed" : "failed");
}
