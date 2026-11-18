// The handlers behind the capability registry (installations plan, P4): what
// each capability's operations do, and who may call them. Code, never profile:
// a profile selects a capability and its operations; the behavior, the
// authorization rule and the write boundary live here.
//
// generate-content runs one write-free generation per job, in the skill's
// language, exactly as the item tools do (`externalWrites: false`): no
// connection write is recorded or sent, whatever the request says.
import type { Principal } from "./auth.js";
import type { IdempotencyClaim } from "./idempotency.js";
import type { CapabilityAuthorization, OperationId } from "./capabilities.js";
import type { ServiceJobDoc } from "./service-jobs.js";
import { createFromDescription, reviseItem } from "./revise.js";

export class CapabilityRefusal extends Error {
  constructor(public reason: string, message: string) {
    super(message);
    this.name = "CapabilityRefusal";
  }
}

// Who may call a capability (its `authorization`), from the caller's auth.
export function authorize(authorization: CapabilityAuthorization, auth: Principal) {
  if (auth.freePlan) throw new CapabilityRefusal("sign_in_required", "This needs an account. Connect with an API key.");
  // A connection-backed capability needs execution, which no release
  // provides yet (capabilities.ts EXECUTION_READY): refuse rather than run it.
  if (authorization === "connection") throw new CapabilityRefusal("connection_required", "This needs an authorized provider connection, which isn't available yet.");
}

const WRITE_FREE = { externalWrites: false } as const;

type Input = Record<string, string>;
type Caller = { token: string; clientKind?: string };

// Validates an operation's input (the capability's schema), before any job exists.
export function operationInput(op: OperationId, args: Record<string, unknown>): Input {
  const need = (name: string) => {
    const v = args[name];
    if (typeof v !== "string" || v.trim() === "") throw new CapabilityRefusal("invalid_argument", `${name} is required.`);
    return v;
  };
  return op === "create" ? { description: need("description") } : { item_id: need("item_id"), modification: need("modification") };
}

// Starts a job's generation: its recorded request (operation and validated
// input), under its pinned definition, with the step's idempotency claim. A
// revision keeps its item's language, which must be one the skill allows.
export function startOperation(job: ServiceJobDoc, caller: Caller, claim: IdempotencyClaim): Promise<unknown> {
  const { definition, request } = job.envelope;
  if (definition.capability.id !== "generate-content") {
    throw new CapabilityRefusal("not_implemented", `Capability ${definition.capability.id} has no handler in this release.`);
  }
  if (!request) throw new CapabilityRefusal("no_request", "This job records no request to run.");
  const { input } = request;
  const languages = definition.skill.languages;
  const common = { client: "mcp", clientKind: caller.clientKind, idempotency: claim };
  if (request.operation === "create") {
    return createFromDescription({ token: caller.token }, { lang: languages[0], description: input.description, ...common }, WRITE_FREE);
  }
  if (request.operation === "revise") {
    return reviseItem({ token: caller.token }, { itemId: input.item_id, modification: input.modification, languages, ...common }, WRITE_FREE);
  }
  throw new CapabilityRefusal("not_implemented", `Operation ${request.operation} has no handler.`);
}
