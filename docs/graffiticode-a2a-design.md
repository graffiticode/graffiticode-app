# Graffiticode shared service architecture and A2A/MCP interfaces

Status: Draft for review\
Date: November 11, 2026\
Updated: November 17, 2026\
Scope: shared `graffiticode-app` frontend and its `graffiticode` backend integration, across installations\
Basis: [MCP/A2A design brief](./mcp-a2a-design-brief.md)

This is the shared architectural reference for frontend service definitions, capability selection, authorization, durable jobs, execution observation, outcomes, recovery, and A2A/MCP translation. Backend execution contracts remain owned by the backend designs; this document consumes them.

The [Artcompiler service design](./artcompiler-a2a-design.md) owns the Learnosity product responsibilities, public identities, supported deliverables, and domain completion requirements. The [installations plan](./installations-plan.md) owns deployment/profile boundaries, and it and the execution observation plan own implementation sequencing (§12). Product profiles use these shared contracts rather than redefining them.

## 1. Decision

**Independent installations use the shared Graffiticode frontend (`graffiticode-app`) to implement and operate specialized services. The Graffiticode backend (`graffiticode`) supplies controlled execution of their work and inspection of the results.**

In this document, **frontend** means the application and agent-service layer, including its server-side code, protocol adapters, console, and generation workers. **Backend** means the language and execution platform, including compilation, interpretation, execution policy, and broker services. These are repository and responsibility boundaries; both layers can contain server-side services.

The frontend implements intent translation, code generation, language selection and composition, and service completion validators. Each installation selects and parameterizes implemented capabilities through an external, versioned profile. The operator owns the product responsibilities and completion requirements. The backend compiles and interprets the generated work within enforced capability boundaries and supplies results and execution evidence. A2A and MCP expose the same service contracts.

Artcompiler's Learnosity installation is the initial product application. Its [service design](./artcompiler-a2a-design.md) defines Assessment Authoring and Data Operations, their two A2A identities, and their initial MCP packaging. Graffiticode's general-purpose MCP interface retains its existing no-external-writes contract.

Define service scope, execution contracts, and verification once in the frontend. Both frontend adapters call these definitions directly and use the same backend execution contracts. An A2A request does not need an additional model that forwards it through MCP.

The initial release offers only capabilities that can be demonstrated end to end. Data-job recipes can ship before data execution; a recipe is a completed planning deliverable, never evidence of a completed provider operation.

## 2. Goals and boundaries

The architecture must support additional frontend service domains without rebuilding authentication, job tracking, clarification, artifact delivery, or recovery. A new profile selects supported intents, language constraints, provider capabilities, and registered completion validators. A new capability or validator implementation is added to shared code before a profile can select it.

A frontend service earns delegation by supplying maintained capability: appropriate generation, reliable execution through the backend, constrained provider access, and evidence of the outcome. A2A itself does not make the underlying work more intelligent or reliable.

The micro-agents exist to do useful work that is **secure, transparent, and accessible**:

- **Secure:** the frontend defines each service's scope; backend execution is constrained by that scope, the caller's grants, and connection policy, with protected operations enforced by backend policy and broker.
- **Transparent:** authorized users can inspect the selected revision or plan, output artifacts, validation results, provenance, and provider evidence where applicable. Uncertainty and incomplete outcomes remain visible.
- **Accessible:** clients can discover and use supported capabilities through A2A and MCP, obtain clarification when needed, and retrieve usable results through documented contracts.

A frontend micro-agent is defined here by its bounded responsibility and observable results. Internal composition and delegation are implementation choices. This design does not require one model, language, internal micro-agent, or deployment per public agent. It does not introduce a general autonomous multi-agent scheduler. Cross-service workflows begin as explicit compositions with recorded child jobs and authority boundaries.

Domain-specific inclusions and exclusions belong to each product contract. The initial Learnosity scope is defined in the [Artcompiler design](./artcompiler-a2a-design.md#2-goals-and-boundaries).

## 3. Current foundation and implementation gaps

This section describes the frontend repository foundation and its backend integration points, not production deployment status. Relative source links refer to `graffiticode-app`.

The frontend already has a shared domain package, [`packages/core`](../packages/core/package.json), used by protocol-facing code. Its generation lifecycle provides durable job envelopes, leases, recovery, revision checks, version records, and effect intents. See [`generation-jobs.ts`](../packages/core/src/generation-jobs.ts), [`effects.ts`](../packages/core/src/effects.ts), and [`idempotency.ts`](../packages/core/src/idempotency.ts). Reuse these mechanisms rather than introducing a second generation engine.

The frontend's existing MCP authoring adapter implementation, [`core-backend.ts`](../packages/mcp-server/src/core-backend.ts), passes a trusted `externalWrites: false` argument. Despite the filename, this is frontend application code. The frontend generation worker skips connection lookup and connection-write effects for these jobs regardless of language routing. The [baseline contract tests](../tests/baseline/mcp-no-external-writes.test.ts) make this an explicit guarantee. Existing `create_item` and `update_item` must retain it.

The frontend's [Learnosity skill](../packages/skills/learnosity/SKILL.md) distinguishes content authoring, authoring-UX integration recipes, and data-job recipes. In particular, the data-job language does not hold credentials or call Learnosity. Existing generation cannot be relabeled as a data execution service.

Connection writes and reconciliation already have frontend integration points in [`writes.ts`](../packages/core/src/writes.ts). The [policy design as built](../packages/console/docs/capability-policy-as-built.md) describes compiler admission checks, policy snapshots, execution tokens, broker receipts, and private artifacts across companion repositories. These are backend execution dependencies reached through frontend integration points. That document contains historical branch and release caveats; it is architectural context, not proof that every prerequisite is deployed today.

New frontend work includes service definitions, service-scope propagation, a durable service-job lifecycle above generation jobs, A2A adapters, a Learnosity-specific MCP catalog, and operation-specific completion validators. Backend work includes enforcing that scope and providing operation-specific execution, receipts, and recovery for Data Operations. Deployment readiness of backend policy, broker, language registry, compiler, interpreter, and gateway must be demonstrated before enabling provider execution.

Service jobs observe backend execution through the backend's [execution observation contracts](https://github.com/graffiticode/graffiticode/blob/main/docs/graffiticode-interpreter-design.md#execution-observation-contracts-proposed) (interpreter design §9, delivered by plan Track E1 and E4). The contracts cover:
- lifecycle classes;
- typed interrupts;
- per-run event cursors;
- the error registry;
- artifact manifests;
- capability declarations;
- a credential-free agent status representation.

The backend owns these contracts, and this design translates them. It does not define parallel ones. They are proposed, not yet deployed. The protocol features in §7 and §8 that depend on them stay disabled until the corresponding backend steps ship.

## 4. General service architecture

### 4.1 Components and ownership

**Frontend service registry.** Serves reviewed, versioned service definitions from the selected installation profile. Shared code owns the profile schema, capability registry, handlers, and validator implementations; profiles select capabilities and supply supported parameters, stable service and skill identifiers, language constraints, output requirements, and limits. Availability and write readiness come from registered code and enforced dependencies. This service registry is distinct from the backend's language registry. The [installations plan](./installations-plan.md#p4-capability-registry-pinned-definitions-and-the-service-tool-family-graffiticode-app) governs profile integration and definition pinning.

**Frontend protocol adapters.** Authenticate requests, resolve the selected service, validate protocol payloads, and translate messages, job state, and artifacts. They own A2A and MCP transport behavior and client compatibility. They do not contain Learnosity business logic.

**Frontend service runtime and code generation.** Resolve caller context, interpret the requested outcome, request missing information, construct a bounded plan, reserve work, and evaluate completion. The frontend owns language selection, composition, code generation, and generation retries. Reuse the existing frontend generation and routing machinery. Every resulting language and operation remains constrained by service scope.

**Backend compilation and interpretation.** Validate and compile frontend-generated language work, then interpret the resulting models through the supported language runtimes. The backend supplies controlled execution, execution state, results, and verification evidence for authorized inspection. Compilation is one stage of a service job. Its successful completion alone does not prove a provider write or a complete export; the frontend evaluates backend evidence against the service's completion contract.

**Backend policy and broker.** Enforce provider access at the operation boundary and perform credentialed calls. The frontend console remains the place for detailed connection and capability management. Frontend service jobs carry connection references; provider secrets stay out of prompts and job artifacts.

**Frontend service jobs and artifact manifests.** Persist the service-level conversation, requested deliverable, child generation jobs, backend execution references, checkpoints, results, and evidence. Backend models, execution records, and receipts remain linked to the frontend job through explicit references. Workers and adapters operate against durable state; an open HTTP stream is never its source of truth. The frontend makes authorized inspection available through its console and protocol artifacts.

The request path is: frontend adapter → frontend service runtime and code generation → backend compilation and interpretation → frontend verification → durable, inspectable result → frontend adapter. Protected backend operations pass through policy and broker. A card or tool catalog is generated from the same frontend service definition used by the runtime.

### 4.2 Service definition

Each definition contains:

- Stable `serviceId`, definition version, public name, responsibility, and explicit exclusions.
- Skills with stable IDs, examples, required context, input schemas, output schemas, and deliverable kinds.
- Allowed languages and composition rules, plus protected functions and broker operations available to each skill.
- Supported provider connection types and resource constraints, including bank and record scope where enforceable.
- References to registered completion validators, their supported parameters, and required evidence for each requested delivery state.
- Limits for elapsed time, generation attempts, records, bytes, provider calls, and cost.
- Protocol exposure settings and deployment feature gates.

Profiles are declarative: handlers, validator implementations, and authorization behavior remain code. The loader rejects unknown or unimplemented capabilities and writing capabilities whose execution dependencies are not ready.

Skill availability is the intersection of implemented handlers, ready dependencies, service configuration, and caller authorization. A definition must not advertise execution merely because a planning language describes that operation.

Pin the definition version for an accepted job. Recheck live authorization when work resumes and at protected operations. Version pinning preserves interpretation; it does not freeze grants after revocation.

### 4.3 Normalized request and result

The internal request carries `serviceId`, authenticated principal and account boundary, optional conversation and job references, intent, input artifact references, requested deliverable, connection reference, constraints, and an idempotency key. Account identity is derived from verified authentication, never accepted from message text.

`deliverableKind` distinguishes `content`, `integration_recipe`, `data_plan`, and `operation_result`. An operation request further specifies its required delivery state, such as prepared, saved, or exported. These are frontend domain fields, not claimed A2A standard fields.

A result carries a concise summary, artifact references, scope processed, verification evidence, warnings, and unresolved exceptions. Persist an explicit external outcome: `not_requested`, `pending`, `not_started`, `applied`, `partially_applied`, or `unknown`. Never translate an unknown provider outcome into success.

The external outcome describes what happened at the provider. It is derived only from evidence the backend has settled, never from a timeout, a deadline or a failed request.

**Per effect.** Each requested external effect has a current status.

An effect is one backend operation, identified by (command, stage, occurrence). For a run, the operations also roll up into per-target evidence. The command's aggregate outcome (`completed`, `failed`, `partial`, `uncertain`) never classifies an individual effect. A `partial` command can contain an effect that was applied and another that wasn't.

The status comes from backend settlement evidence for that operation:
- the operation's own recorded outcome, which the command record keeps for every operation (interpreter design §5);
- updated by any linked reconciliation evidence;
- updated by the repair ledger's entry for that (original command, stage, occurrence), which is its current outcome across the original command and every repair.

An effect first recorded uncertain can therefore later be confirmed applied or confirmed not applied. The original operation outcome and the command's aggregate outcome stay in history, but no longer determine the current status.

**Statuses:**
- **Settled applied:** the provider confirms the requested state. This includes targets the backend recorded as already satisfied, which are reported separately.
- **Settled partially applied:** the operation is `partial`. Some of its steps were written, and the rest are settled as not written.
- **Settled not applied:** the operation is `failed`, so it wrote nothing. This includes a target the backend recorded as skipped with no write.
- **Unresolved:** settled as `uncertain`, and not yet reconciled.
- **Pending:** the backend hasn't settled it yet.

These rules are the same for immediate commands and runs.

**Aggregation over the job's effects**, applied in order:

| Current effect statuses | External outcome |
| --- | --- |
| No external effect requested | `not_requested` |
| Any effect pending | `pending`. Not a terminal outcome, except for a detached observer job (§6.3) |
| Any effect unresolved | `unknown`. The result still lists the effects known to be applied |
| All settled not applied | `not_started` |
| All settled applied | `applied` |
| Otherwise: some write happened and some requested change didn't (any partially applied effect, or a mix of applied and not applied) | `partially_applied` |

So one completed write followed by a definite failure is `partially_applied`, whether the two operations belong to one immediate command or to a run. Uncertainty resolved by later reconciliation stops counting as `unknown`.

**Service success and provider outcome are separate.**
- Frontend validators decide whether the service's completion contract is met (§6.3). They never change the external outcome.
- A validation failure fails the service while preserving the known committed effects. For example, the job is `failed`, with external outcome `applied` and the validation findings.
- The frontend never upgrades backend evidence.

## 5. Authorization and action boundaries

Use the brief's rule:

**Effective capabilities = service scope ∩ console grants ∩ connection policy.**

The frontend supplies the service scope and manages grants through its console. The backend enforces the effective capabilities when executing protected operations.

For each operation, narrow this further to the requested action and target resources. A preview request remains unable to save even if the principal owns a connection with write permission. A Data Operations identity cannot invoke every broker operation just because the caller's connection permits them.

The frontend's existing trusted `externalWrites: false` argument demonstrates a useful restriction but is not a complete service policy. Provider-enabled jobs need a trusted, server-created execution scope bound to service, job, principal, connection, permitted actions, resource limits, and policy version. The frontend carries that binding in its backend execution requests; backend policy and broker enforce it. If the backend cannot enforce the restriction, that execution skill remains disabled. Prompt instructions and filtered catalogs are insufficient.

Resolve and bind a connection before execution. Never switch to a newly selected default connection during recovery. Check ownership or delegation, provider account, active status, and operation permissions. Authentication of a calling agent does not by itself establish authority to act for an end user; use an existing verified delegated identity or a separately scoped service principal.

Calls to read, resume, cancel, or retrieve artifacts require the same account and service ownership checks as submission. Job IDs, A2A context IDs, and artifact URLs are identifiers, not grants. Public cards reveal no tenant-specific bank details. Shared contexts do not imply shared authorization.

Content preparation cannot become a provider write through natural-language revision. For a write-capable service, explicit requested delivery state and permitted scope authorize the action. If connection policy requires additional approval, pause with a concrete plan identifying target bank, revision, scope, and expected changes. Existing authorization can satisfy this requirement; avoid redundant approvals. Bind any approval to the plan digest and invalidate it when material scope changes.

## 6. Durable service jobs

### 6.1 Distinct identifiers

A **frontend service job** tracks responsibility for an outcome. An **A2A task** is that job's protocol representation. An **MCP extension task**, when supported, is another representation. A **frontend generation job** runs one generation or revision stage. A Graffiticode **Task = (lang, code)** identifies the generated language work submitted to the backend.

On the backend:
- A **backend command** is one admitted `POST /command`, with its own idempotency key and recorded outcome.
- A **backend run** is the durable execution that a start command creates. Its record is authoritative for execution progress.

Persist explicit mappings; do not overload `taskId`. A frontend service job may reference several generation jobs, Graffiticode tasks, backend commands and runs, provider invocations, and artifacts. Protocol IDs are scoped to the relevant adapter, account, and service.

**Correlation.** The A2A `contextId` maps to the backend's account-scoped context id, passed on create, update and `/command`. That links generation, revisions, runs, reconciliations and repairs in one history. Like the protocol ID, it is correlation metadata only: it grants no access and doesn't deduplicate work. A reconciliation or repair still names the command it acts on explicitly.

### 6.2 Persistence

Introduce a frontend service-job record, provisionally `service-jobs/{jobId}`, with:

- Immutable service/version, principal/account, accepted intent, deliverable, connection, limits, input digests, and creation time.
- Mutable state and revision, deadline, cancellation request, waiting question and continuation token, and current plan revision.
- Child-generation and backend execution references, provider invocation IDs, operation checkpoints, and artifact manifests.
- Completion or failure details, verification results, and external outcome.

Persist events with monotonic per-job sequence numbers. Commit transitions and their dispatch intents atomically, then use the existing outbox/lease pattern for delivery. Generation remains in `generation-jobs`; the parent job does not copy or independently mutate its dispatch state.

The same rule applies to backend runs. The job stores:
- command and run references;
- each run's last consumed event cursor;
- the command outcomes it has observed.

It does not mirror step state. The job reads the run's events after its stored cursor, translates them into job events, and advances the cursor only after committing them. Replays therefore deduplicate on (run id, sequence). A `cursor-expired` reset is handled by reading a fresh snapshot and recording the gap explicitly in the job's history. Job events and backend run events have separate sequences; a job event records the run sequence it was derived from.

Do not store bearer tokens for replay. Resume work using the existing bounded grant model where applicable and current policy checks. Inputs and outputs containing assessment results require access-controlled storage, configured retention, and deletion behavior.

### 6.3 Lifecycle and clarification

Internal lifecycle: `accepted` → `working` → `completed` or `failed`. `working` may pause at `input_required` or `auth_required`, then resume. `rejected` describes a task-level refusal under the selected protocol; malformed or unauthenticated requests can fail before job creation. `canceled` is terminal only after work has stopped or been safely fenced.

Clarification records the specific missing fact, expected answer shape, affected plan revision, and expiry. Answers must name the existing job and current question, pass ownership checks, and be applied once. Missing bank identity or deployment details must not be guessed. New requirements that change a completed deliverable create a new job linked to the same conversation.

**Two sources of interruption.** A job can be interrupted before or after it starts backend execution:
- **Preparation questions** arise before any backend command. They are frontend clarification records. Answering one regenerates and recompiles a new task revision, without calling the backend.
- **Run interrupts** are backend interrupt records, each with `interruptId`, revision, kind, resolver, question and answer schemas, and expiry. The job surfaces the backend's schema rather than restating it.
  - An answer becomes a backend `dispatch` command that names the interrupt's id and revision, keyed by an answer submission (§6.4).
  - The answer is not tied to the run's `stateVersion`. Unrelated progress doesn't make it stale; a revised interrupt does.

The job records which source asked, so a continuation is routed correctly.

**State mapping.** Three different things decide three different questions:
- **Continuation** (whether the job is still going) is governed by the run's lifecycle class.
- **Service success** (completed or failed) is governed by the frontend's completion validators.
- **What happened at the provider** is the external outcome in §4.3.

A terminal command alone determines none of these. For example, an initiating command can end `uncertain` while its run sits in a `reconciliation` interrupt. The job is then interrupted, not failed.

| Backend | Job / A2A state |
| --- | --- |
| No command yet (preparing) | `accepted`, then `working` |
| Run active, including provider waits and automatic reconciliation; or a command `pending` | `working` |
| Interrupt `input` or `reconciliation` that the caller can resolve | `input_required` |
| Interrupt `authorization` that the caller can resolve | `auth_required` |
| Interrupt the caller can't resolve (resolver is an administrator or the operator, e.g. `dependency`) | `working`, with a status message naming the blocker and resolver. The deadline rule in §6.4 applies |
| Run `stopped` (a stop requested by the caller) | `canceled` |
| Run terminal otherwise, or an immediate command settled with no run | The completion validators decide: `completed` if the service's completion contract is met, otherwise `failed`. Completed with exceptions passes only if the request permitted those exclusions |
| Refused by capability preflight before allocation | `rejected`, or a protocol error with no job |

Each terminal job state carries the external outcome from §4.3. A `failed` job can carry `applied` or `partially_applied`, and a `completed` job can carry `applied` with exceptions. The job never claims a terminal state while a run it submitted is active or interrupted, or while any effect it submitted is `pending`.

**Observer steps.** A step can *adopt* an existing execution instead of submitting one, for example a save the console or another job already made (§6.4). Such a step observes the execution; it doesn't own it.
- Its job's deadline and cancellation never touch the adopted execution.
- When the job's deadline passes, or the job is cancelled, while the adopted execution is still `pending`, the job *detaches*. It ends `failed` against its completion contract, with external outcome `pending`, marked `detached`. It carries the owning execution reference, so a caller can follow it.
- Detaching is the only way a job ends with a `pending` effect.

**After a terminal state.** A terminal job does not change. If its run later changes, for example through an admitted reconciliation, that is a new job in the same context. It references both the earlier job and the run.

A2A maps these states through the selected SDK's task-state enum. MCP Tasks-extension execution maps to its supported states; authentication handling remains in the MCP adapter. Without the extension, return a domain job handle and use explicit status/continuation tools. Do not claim those handles are MCP protocol tasks. A status result must preserve the original requested deliverable and any unresolved external outcome.

### 6.4 Retry, cancellation, and partial execution

Scope idempotency to account, principal, service, operation, and client key, and bind it to an input digest. The same key and digest returns the existing job; different input is a conflict. A retry through another interface reaches the same job only when the caller explicitly supplies the shared domain key and passes ownership checks. Conversation IDs alone do not deduplicate work.

**Retention.** Job key bindings (`service-job-keys`, `packages/core/src/service-jobs.ts`) follow the pattern in `packages/core/src/idempotency.ts`: a hashed scope and key, an input fingerprint, and a mismatch on reuse. They are bound in the job's own creating transaction, and they don't inherit generation's 24-hour TTL.
- A binding never expires while its job is not terminal.
- After the job ends, the binding is kept for a retry window that the service definition records.
- A retry after the window is a new job. ([Execution observation plan](https://github.com/graffiticode/graffiticode/blob/main/docs/execution-observation-plan.md), D-1.)

Assign deterministic child-step identities and provider operation keys. Reuse them after worker crashes or lost responses. Reuse existing gateway and broker invocation/receipt semantics where available. Exactly-once external execution is not assumed.

**Backend command keys** are derived, never freshly minted:
- a start key from (job, step);
- a dispatch key from (job, answer submission id), or from (job, cancel request id).

Keys are immutable per attempt, and persisted when the attempt is created.

**Saves go through a shared save head** (execution observation plan, D-5):
- **The head.** Each save identity, `saveWriteKey(item, task, connection)`, has one save head in Policy. It points at the current attempt through a protocol-aware **execution reference**: `{protocol: "command", commandId}` or `{protocol: "legacy", invocationId}`.
- **Adopt or submit.** A save step resolves the head:
  - **An attempt exists** (from the console, another job, or a recorded legacy save): the step *adopts* it under its existing admission, attaching no scope or deadline, and becomes an observer (§6.3).
  - **No attempt exists:** the step *submits* a newly scoped command. The head, the allocation and the dispatch intent commit in one Policy transaction.
  - **A race:** the loser gets an `adoptable` refusal carrying the winner's reference, and adopts it.
- **Retries go through the head.**
  - Only a `failed` command attempt can be retried, by atomically claiming the next attempt on the head. Concurrent claimants converge on one retry.
  - `partial` and `uncertain` attempts go to reconciliation or repair.
  - A legacy attempt is recovered only through its own recorded legacy path.
- **One reference everywhere.** Step records, `job_get`, A2A status and detached-job references all use the execution reference.
- **Status reads** resolve the reference by its protocol and never start or advance execution.

An **answer submission** is persisted when the frontend accepts an answer, before it dispatches:
- The submission names the interrupt id and revision. Retries of that submission reuse its id, and so its key.
- A submission that is definitively refused doesn't resolve the interrupt. Two examples are a Policy refusal, which carries Policy's own registered reason, and an answer that fails the interrupt's answer schema. A corrected answer, or a resubmission after authorization is restored, is a new submission with a new id. It neither conflicts with the refusal nor replays it.
- The backend resolves an interrupt revision atomically, once. The first accepted submission resolves it, and later submissions for that revision get `event-not-applicable`.

Generation retries are allowed only before a step's first start. Once a command for a step exists, the only routes forward are its recorded outcome, an admitted reconciliation, or a repair. A new key with regenerated code is never one of them.

**Backend errors** arrive as reasons from the backend's FAIL-01 registry (`packages/common/src/failures.ts`). Each carries one of its five native categories (`authentication`, `permission`, `malformed`, `conflict`, `unavailable`), typed details, and context-aware recovery guidance:
- **Translation.** The service job consumes the native category and reason. Adapters translate them only at the protocol boundary, and keep the backend reason in the error details.
- **A category alone never authorizes a retry.** The job follows the recovery guidance, read against the recorded outcome.
- **Errors never settle outcomes.** Command outcomes are settled only by the backend (Policy and Broker receipts). An error neither creates nor overwrites one.
  - After a transport failure or lost response, the job keeps the command's current recorded outcome, which may still be `pending`. It retries with the same key, or reads status, until the backend settles it.
  - The job never records `not_started` or `unknown` because a request failed.
- **The three dispatch refusals stay distinct:**
  - `event-not-understood` (`malformed`): unsupported;
  - a Policy refusal, with Policy's own registered reason: not permitted;
  - `event-not-applicable` (`conflict`): a stale or conflicting answer, which leaves the job unchanged.

A provider timeout after submission can mean the write happened. The frontend doesn't classify it. The backend settles the operation through its receipts: it records `uncertain` when the outcome can't be established, then reconciles using provider references and supported readback, and blocks blind replay. The job reflects that settled evidence (§4.3). Reconciliation itself requires authorization. A new key must never be silently generated to get past an uncertain receipt.

Cancellation is cooperative: stop scheduling, check cancellation between bounded operations, and report committed changes. It does not undo provider writes. Keep the job nonterminal while an in-flight effect can still commit. Compensation requires an explicit, separately authorized plan.

**Cancelling once a run exists.**
- **Stop.** Cancellation sends a stop `dispatch`, and the job stays `working` until the run reaches `stopped`. The cancel artifact lists committed effects and any remote provider jobs that may still be active.
- **Deadline.** The job deadline is carried into backend admission, so the run stops itself when it passes. A deadline determines neither the job's state nor the external outcome:
  - When it passes, the job waits for the run to stop and the backend to settle its in-flight effects, then terminates. It is `failed` against its completion contract, with the settled external outcome, which may be `unknown` if the backend settled `uncertain`.
  - If the backend can't be reached, the job stays `working`, with a status message, until settlement can be read.
  - The frontend never fails a job on its deadline while the run keeps working unobserved, and never assigns an outcome the backend hasn't settled.
- **Observers.** These rules apply to executions the job submitted. For an adopted execution, the job's cancel and deadline only detach it (§6.3). No stop is sent, and the owner's execution continues to its own settlement.

## 7. A2A interface

### 7.1 Identities, discovery, and versioning

Generate Agent Cards for the public service identities selected by the installation profile, from the same definitions used by its service runtime and MCP catalog. Branding, enabled services, supported skills, and endpoint routing are installation configuration. The pilot identities and proposed paths are defined in the [Artcompiler product design](./artcompiler-a2a-design.md#7-a2a-public-identities).

The cards identify frontend services that use the backend for controlled execution and result inspection. Each public identity groups a coherent responsibility and its supported skills; backend languages and internal micro-agents do not automatically receive separate cards. In this design, an A2A endpoint is a frontend protocol access point. The [A2A core concepts](https://a2a-protocol.org/latest/topics/key-concepts/) allow a remote agent to be an agent or agentic system, so an endpoint does not determine whether its implementation performs work directly or delegates internally.

Use directly configured card URLs or a catalog to discover multiple identities on a shared host. The standard root `/.well-known/agent-card.json` returns a single Agent Card; do not put a card array there. If root discovery is required for each identity, use separate hostnames or another supported routing arrangement.

Each card describes responsibility, currently enabled skills, examples, input/output media types, security requirements, and supported interfaces. Pin an A2A release and SDK together; validate cards and payloads against that release. Keep protocol version, service-definition version, and artifact-schema version separate. The current [A2A specification](https://a2a-protocol.org/latest/specification/) defines cards, task interaction, artifacts, discovery, and transport bindings; `latest` is a research link, not a deployment version pin.

Start with one HTTP binding, durable task retrieval, multi-turn continuation, and cancellation. Add streaming when a target client needs it; add push after authenticated callback delivery and retry behavior are implemented. Advertise optional features only after interoperability checks. Hosting both identities together does not grant either identity the other's scope.

**Delivery and observation:**
- **Pilot.** Get Task reads the job, which is kept current by polling backend runs with event cursors (§6.2).
- **Later.** Streaming and push are built on the job's event log, and on the backend's replay streams and webhooks once those ship. A subscription starts from the current task and continues from the job's event sequence.
- **Submission.** Backend submission is always nonblocking. Where the pinned A2A version blocks Send Message by default, the adapter either waits for the job without holding an execution worker or lease, or the skill's examples tell clients to request nonblocking mode. Durable data operations use the latter.

**Skill advertisement** follows backend capability declarations. A skill that needs execution is advertised only when the interpreter manifest declares its operations and they are activated. A message that maps to an undeclared operation is refused before any backend allocation.

### 7.2 Messages and artifacts

Accept natural-language intent with optional structured domain input. Return messages for clarification and progress; return artifacts for deliverables. Use plain text or Markdown for recipes and summaries, JSON for structured assessment payloads and manifests, and downloadable files for exports. Preview links are optional authenticated conveniences; completion must remain understandable to clients without embedded frontend components.

Domain artifact manifests include schema version, content type, digest, provenance, service-job ID, relevant content revision, delivery state, and verification references. Resolve artifacts through authorized retrieval or narrowly scoped expiring URLs. Do not expose language-private ASTs as a general cross-service contract; use a platform-neutral spec when moving intent between languages.

Backend outputs reach A2A from backend artifact manifests:
- **Sealed manifests** become A2A artifacts. The domain manifest references the backend `artifactId`, manifest version and content digest.
- **Open manifests** may be exposed for progress, for example a partial export. They are explicitly marked incomplete and never satisfy an export's completion contract.
- **Exceptions** are their own named artifact.

Status text comes from the backend's credential-free agent status representation, never from the form's `present` result, so A2A tasks and messages carry no signatures or bearer URLs. A refreshed presentation credential produces no status update. Run projections are mutable and are never published as artifacts.

## 8. MCP interface and compatibility

The shared frontend supports generic item tools and a service-tool family generated from the installation profile's selected skills. Each skill has a stable, explicit name, input/output contract, and registered handler. The profile selects which supported families each endpoint exposes. The [Artcompiler MCP product surface](./artcompiler-a2a-design.md#8-mcp-product-surface) defines the initial Learnosity tool names. Shared `job_get`, `job_continue`, and `job_cancel` cover the fallback service-job interface.

Each tool accepts rich intent within its named purpose and enforced service scope. A planning call cannot execute merely because its description includes execution instructions. Tool descriptions and side-effect annotations must match actual behavior; profiles cannot introduce side effects absent from their registered capabilities.

Filter discovery by authorization, and recheck authorization at invocation. MCP supports authorization-dependent tool catalogs; grouping into two toolsets is frontend configuration, with no assumption that every client exposes group toggles. See the [MCP tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).

Use the [MCP Tasks extension](https://github.com/modelcontextprotocol/ext-tasks/blob/main/specification/2026-07-28/tasks.md) only when negotiated and implemented. Client compatibility determines whether clarification uses elicitation, task-associated interactions, or explicit continuation. These are adapter choices over one service job.

The fallback tools use the same contracts as A2A:
- `job_get` returns the job state from §6.3, with backend artifacts and agent status.
- `job_continue` answers the current preparation question or backend interrupt, by id and revision.
- `job_cancel` follows §6.4: it requests stop for an execution the job submitted, or detaches from an adopted execution.

Endpoint packaging is a product decision. Splitting an endpoint preserves the service IDs and shared execution contracts; the initial Artcompiler arrangement and split criteria are in its [product design](./artcompiler-a2a-design.md#8-mcp-product-surface).

## 9. Learnosity Assessment Authoring

The product's supported responsibility, prepared/previewed/saved completion requirements, save binding, and authoring-integration recipes are defined in [Artcompiler §9](./artcompiler-a2a-design.md#9-learnosity-assessment-authoring). Its profile selects registered capabilities and validators under the shared contracts in §4–§8.

## 10. Learnosity Data Operations

The product's planning/execution boundary, read and export completeness, transformation and migration requirements, and composition with authoring are defined in [Artcompiler §10](./artcompiler-a2a-design.md#10-learnosity-data-operations). Backend execution and evidence remain governed by the shared contracts; product-specific completion requirements are maintained in that one document.

## 11. Operational behavior and verification

Correlate frontend service/job IDs, definition version, adapter, and generation references with backend execution IDs, policy decisions, and operation/receipt IDs. Record state transitions, verification outcomes, and resource usage across both layers. Keep secrets, full prompts, assessment answers, and result payloads out of routine logs. Provide tenant-scoped audit access separately from operational metrics.

Measure completion against requested delivery state, clarification rate, latency, provider errors, unknown outcomes, reconciliation age, records processed, and cost per verified outcome. Generation success alone is an insufficient service metric.

Apply per-account and per-connection concurrency and provider rate limits. Persist deadlines and budgets. A dependency failure disables affected execution skills without preventing safe preparation or planning. Roll back an adapter or disable a skill while preserving durable jobs and their pinned definition handlers until those jobs drain or are explicitly failed.

Before release, demonstrate:

- Equivalent service requests through MCP and A2A produce the same authorization decision and completion evidence.
- Preview, content revision, and data planning cannot invoke writes, including after routing or language composition.
- Cross-account job, context, connection, and artifact access is refused; revoked access is rechecked on resume and operation execution.
- Lost submission responses, duplicate deliveries, worker crashes, and effect retries do not silently create fresh write invocations.
- Clarification survives disconnects, stale answers conflict, cancellation fences further work, and unknown writes remain unresolved until reconciled.
- Domain validators and artifacts satisfy the selected service definition's completion contract. The initial Learnosity acceptance cases are in [Artcompiler §11](./artcompiler-a2a-design.md#11-product-verification).
- Cards and tool catalogs advertise only ready skills; target clients handle the selected protocol version, auth, continuation, task retrieval, and artifacts.

Use deterministic provider doubles for failure injection and isolated provider test environments for live execution verification. Keep production data out of these checks. The existing no-external-writes baseline remains a regression gate.

## 12. Delivery plan

Implementation sequencing, milestones, and cross-cutting decisions are owned by the [execution observation plan](https://github.com/graffiticode/graffiticode/blob/main/docs/execution-observation-plan.md). It coordinates immediate-command service jobs, durable backend runs, operation-specific execution, and the A2A pilot. Its decisions D-1 to D-6 govern this design where applicable, including key retention, service scope, save adoption, and storage ownership.

The [installations plan](./installations-plan.md) owns external profiles, capability selection and service-tool generation, application storage isolation, browser runtime configuration, the OAuth resource boundary, and installation-aware backend authorization. Its Artcompiler acceptance deployment remains gated on those prerequisites.

This document defines shared behavior; the [Artcompiler product design](./artcompiler-a2a-design.md) defines the pilot's service deliverables. Neither maintains an independent implementation phase schedule. A skill is advertised only after its implementation, authorization, execution, and interoperability gates in the relevant plans pass.

## 13. Review decisions still needed

- Which target A2A client and protocol/SDK release define the pilot compatibility matrix?
- How will caller-agent identity map to an end-user delegation or a scoped service principal in the existing auth model?
- What frontend scope propagation and backend policy/broker changes are required to enforce the service/job/action scope end to end, and which are deployed?
- What account-specific retention, size, runtime, cost, and approval policies apply to stored results and bulk writes?

- When do the backend's execution observation contracts ship? Specifically: Track E1's event log, interrupts, artifact manifests, error registry and capability declarations, and E4's cursors and agent status. Can backend admission carry the service-scope claim and job deadline that §5 and §6.4 require?

Product-specific choices, including public identities, distribution, and the first executable Learnosity record families, are maintained in [Artcompiler §13](./artcompiler-a2a-design.md#13-product-decisions-still-needed).

These decisions gate the affected execution features. They do not prevent implementing the shared contracts, content preparation, or documentation-only planning.
