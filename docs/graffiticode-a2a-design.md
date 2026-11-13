# Graffiticode A2A frontend and backend design

Status: Draft for review  
Date: November 11, 2026  
Scope: `graffiticode-app` frontend and `graffiticode` backend  
Basis: [MCP/A2A design brief](./mcp-a2a-design-brief.md)

## 1. Decision

**The Graffiticode frontend (`graffiticode-app`) implements and operates specialized micro-agents. The Graffiticode backend (`graffiticode`) supplies controlled execution of their work and inspection of the results.**

In this document, **frontend** means the application and agent-service layer, including its server-side code, protocol adapters, console, and generation workers. **Backend** means the language and execution platform, including compilation, interpretation, execution policy, and broker services. These are repository and responsibility boundaries; both layers can contain server-side services.

The frontend owns domain expertise, intent translation, code generation, language selection and composition, and the completion contract for each service. The backend compiles and interprets the generated work within enforced capability boundaries and supplies results and execution evidence. A2A and MCP expose the frontend's service contracts.

Use Learnosity as the initial domain with two frontend services:

- **Assessment Authoring:** create and revise assessment content, validate it, provide previews, and eventually save an explicitly selected revision through an authorized connection.
- **Data Operations:** plan and eventually execute bounded reads, exports, transformations, and migrations of assessment records and collections.

Expose two A2A Agent Cards and initially one Learnosity-specific frontend MCP endpoint with two bounded toolsets. Keep the existing general-purpose frontend MCP interface and its no-external-writes contract intact. The proposed Learnosity MCP endpoint is a distinct interface; adding it does not silently add writes to existing tools.

Define service scope, execution contracts, and verification once in the frontend. Both frontend adapters call these definitions directly and use the same backend execution contracts. An A2A request does not need an additional model that forwards it through MCP.

The initial release offers only capabilities that can be demonstrated end to end. Data-job recipes can ship before data execution; a recipe is a completed planning deliverable, never evidence of a completed provider operation.

## 2. Goals and boundaries

The architecture must support additional frontend service domains without rebuilding authentication, job tracking, clarification, artifact delivery, or recovery. A new service should primarily supply its supported intents, language constraints, provider operations, and completion validators.

A frontend service earns delegation by supplying maintained capability: appropriate generation, reliable execution through the backend, constrained provider access, and evidence of the outcome. A2A itself does not make the underlying work more intelligent or reliable.

The micro-agents exist to do useful work that is **secure, transparent, and accessible**:

- **Secure:** the frontend defines each service's scope; backend execution is constrained by that scope, the caller's grants, and connection policy, with protected operations enforced by backend policy and broker.
- **Transparent:** authorized users can inspect the selected revision or plan, output artifacts, validation results, provenance, and provider evidence where applicable. Uncertainty and incomplete outcomes remain visible.
- **Accessible:** clients can discover and use supported capabilities through A2A and MCP, obtain clarification when needed, and retrieve usable results through documented contracts.

A frontend micro-agent is defined here by its bounded responsibility and observable results. Internal composition and delegation are implementation choices. This design does not require one model, language, internal micro-agent, or deployment per public agent. It does not introduce a general autonomous multi-agent scheduler. Cross-service workflows begin as explicit compositions with recorded child jobs and authority boundaries.

Learner delivery, human-facing reporting, and unrestricted Learnosity administration are outside the initial service scope. Embedding Learnosity's authoring UI is an authoring integration-planning skill when supported by a current language; it does not require a third public identity.

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

**Frontend service registry.** Stores reviewed, versioned service definitions. Owns stable service and skill identifiers, supported requests, allowed language compositions, maximum provider capabilities, output contracts, and completion criteria. Deployment configuration enables a subset of implemented skills. This service registry is distinct from the backend's language registry.

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
- Completion validators and required evidence for each requested delivery state.
- Limits for elapsed time, generation attempts, records, bytes, provider calls, and cost.
- Protocol exposure settings and deployment feature gates.

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
| Any effect pending | `pending` (not a terminal outcome) |
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

Each terminal job state carries the external outcome from §4.3. A `failed` job can carry `applied` or `partially_applied`, and a `completed` job can carry `applied` with exceptions. The job never claims a terminal state while the run is active or interrupted, or while any effect is `pending`.

**After a terminal state.** A terminal job does not change. If its run later changes, for example through an admitted reconciliation, that is a new job in the same context. It references both the earlier job and the run.

A2A maps these states through the selected SDK's task-state enum. MCP Tasks-extension execution maps to its supported states; authentication handling remains in the MCP adapter. Without the extension, return a domain job handle and use explicit status/continuation tools. Do not claim those handles are MCP protocol tasks. A status result must preserve the original requested deliverable and any unresolved external outcome.

### 6.4 Retry, cancellation, and partial execution

Scope idempotency to account, principal, service, operation, and client key, and bind it to an input digest. The same key and digest returns the existing job; different input is a conflict. A retry through another interface reaches the same job only when the caller explicitly supplies the shared domain key and passes ownership checks. Conversation IDs alone do not deduplicate work.

Assign deterministic child-step identities and provider operation keys. Reuse them after worker crashes or lost responses. Reuse existing gateway and broker invocation/receipt semantics where available. Exactly-once external execution is not assumed.

**Backend command keys** are derived, never freshly minted:
- a start key from (job, step);
- a dispatch key from (job, answer submission id), or from (job, cancel request id).

An **answer submission** is persisted when the frontend accepts an answer, before it dispatches:
- The submission names the interrupt id and revision. Retries of that submission reuse its id, and so its key.
- A submission that is definitively refused doesn't resolve the interrupt. Two examples are `policy-refused`, and an answer that fails the interrupt's answer schema. A corrected answer, or a resubmission after authorization is restored, is a new submission with a new id. It neither conflicts with the refusal nor replays it.
- The backend resolves an interrupt revision atomically, once. The first accepted submission resolves it, and later submissions for that revision get `event-not-applicable`.

Generation retries are allowed only before a step's first start. Once a command for a step exists, the only routes forward are its recorded outcome, an admitted reconciliation, or a repair. A new key with regenerated code is never one of them.

**Backend errors** arrive as registry codes with a category and recovery guidance:
- **Translation.** Adapters translate by category and keep the backend code in the error details.
- **Errors never settle outcomes.** Command outcomes are settled only by the backend (Policy and Broker receipts). An error neither creates nor overwrites one.
  - After a transport failure or lost response, the job keeps the command's current recorded outcome, which may still be `pending`. It retries with the same key, or reads status, until the backend settles it.
  - The job never records `not_started` or `unknown` because a request failed.
- **The three dispatch refusals stay distinct:**
  - `event-not-understood`: unsupported;
  - `policy-refused`: an authorization refusal;
  - `event-not-applicable`: a stale or conflicting answer, which leaves the job unchanged.

A provider timeout after submission can mean the write happened. The frontend doesn't classify it. The backend settles the operation through its receipts: it records `uncertain` when the outcome can't be established, then reconciles using provider references and supported readback, and blocks blind replay. The job reflects that settled evidence (§4.3). Reconciliation itself requires authorization. A new key must never be silently generated to get past an uncertain receipt.

Cancellation is cooperative: stop scheduling, check cancellation between bounded operations, and report committed changes. It does not undo provider writes. Keep the job nonterminal while an in-flight effect can still commit. Compensation requires an explicit, separately authorized plan.

**Cancelling once a run exists.**
- **Stop.** Cancellation sends a stop `dispatch`, and the job stays `working` until the run reaches `stopped`. The cancel artifact lists committed effects and any remote provider jobs that may still be active.
- **Deadline.** The job deadline is carried into backend admission, so the run stops itself when it passes. A deadline determines neither the job's state nor the external outcome:
  - When it passes, the job waits for the run to stop and the backend to settle its in-flight effects, then terminates. It is `failed` against its completion contract, with the settled external outcome, which may be `unknown` if the backend settled `uncertain`.
  - If the backend can't be reached, the job stays `working`, with a status message, until settlement can be read.
  - The frontend never fails a job on its deadline while the run keeps working unobserved, and never assigns an outcome the backend hasn't settled.

## 7. A2A interface

### 7.1 Identities, discovery, and versioning

Publish the frontend's **Learnosity Assessment Authoring** and **Learnosity Data Operations** services as distinct cards. Proposed frontend application paths are `/agents/learnosity/authoring` and `/agents/learnosity/data`; their exact host is a deployment decision.

The cards identify frontend services that use the backend for controlled execution and result inspection. Each public identity groups a coherent responsibility and its supported skills; backend languages and internal micro-agents do not automatically receive separate cards. In this design, an A2A endpoint is a frontend protocol access point. The [A2A core concepts](https://a2a-protocol.org/latest/topics/key-concepts/) allow a remote agent to be an agent or agentic system, so an endpoint does not determine whether its implementation performs work directly or delegates internally.

Use directly configured card URLs or a catalog to discover both identities on a shared host. The standard root `/.well-known/agent-card.json` returns a single Agent Card; do not put a card array there. If root discovery is required for each identity, use separate hostnames or another supported routing arrangement.

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

The frontend's Learnosity-specific MCP catalog uses stable, explicit names. Proposed authoring tools are `assessment_create_item`, `assessment_update_item`, and `assessment_preview_item`; add `assessment_save_item` only after provider execution is ready. Proposed data tools are `data_plan`, then `data_query`, `data_export`, and eventually `data_migrate` as their handlers mature. Shared `job_get`, `job_continue`, and `job_cancel` cover the fallback job interface.

Each tool accepts rich intent within its named purpose. Save requires an immutable content revision and selected connection. A planning call cannot execute merely because its description includes execution instructions. Migration cannot be hidden in a read tool. Tool descriptions and side-effect annotations must match actual behavior.

Filter discovery by authorization, and recheck authorization at invocation. MCP supports authorization-dependent tool catalogs; grouping into two toolsets is frontend configuration, with no assumption that every client exposes group toggles. See the [MCP tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).

Use the [MCP Tasks extension](https://github.com/modelcontextprotocol/ext-tasks/blob/main/specification/2026-07-28/tasks.md) only when negotiated and implemented. Client compatibility determines whether clarification uses elicitation, task-associated interactions, or explicit continuation. These are adapter choices over one service job.

The fallback tools use the same contracts as A2A:
- `job_get` returns the job state from §6.3, with backend artifacts and agent status.
- `job_continue` answers the current preparation question or backend interrupt, by id and revision.
- `job_cancel` issues the stop `dispatch` once a run exists.

Initially deploy one Learnosity endpoint. Split it when authoring and data operations need independent installation, administration, access arrangements, distribution, or operational isolation. A client that trusts only entire connections is a concrete reason to split. Both endpoints would retain the same service IDs and execution rules.

## 9. Learnosity Assessment Authoring

### 9.1 Supported responsibility

Accept subject, audience, quantity, question and activity structure, scoring intent, feedback, accessibility requirements, metadata, and requested delivery state. Use current language descriptions and scope metadata to select content authoring or integration planning; public skill IDs must not encode a remembered language number.

For content, the frontend micro-agent generates or revises language-specific code and uses the backend to compile and interpret it. The frontend evaluates structure, item/activity references, scoring configuration, and requested content constraints using the available validators and backend evidence, and provides a preview where available. Separate machine-checked validity from pedagogical quality judgments and any requested human review. A successful render does not prove the scoring model or all requested restrictions are correct.

Content stages are:

1. **Prepared:** the selected revision exists, required checks pass, and any warnings are explicit.
2. **Previewed:** that revision has a usable preview; no item-bank write is implied.
3. **Saved:** the authorized save of that revision has confirmed provider evidence and returned item/activity references.

Complete against the requested stage. If the caller requested a save, preparation alone is an intermediate result. Saving does not imply publication or learner delivery.

### 9.2 Save execution

Prepare and validate with writes disabled. The frontend binds save to the immutable generated artifact, target connection/bank, reference mapping, overwrite policy, and requested state. The backend executes the reviewed operation through policy and broker and records the receipt. The frontend uses that evidence and supported readback to verify the resulting references and content. Any generation after review produces a new revision requiring renewed validation and action binding.

Use optimistic concurrency for revisions and provider preconditions where available. When provider conditional writes are unavailable, declare the concurrency limitation and avoid claiming atomic overwrite protection.

Do not reuse the frontend console's automatic write-through behavior as an implicit consequence of authoring. The service's provider action must be an explicit, constrained stage. Add tests showing that an instruction to save inside a create, revise, or preview request still cannot write.

### 9.3 Authoring integration planning

When a supported language models embedding an item editor, browser, or activity editor, the frontend produces a host-neutral recipe using that language. Require actual deployment facts such as serving domain, author identity, bank, and relevant references. Preserve confidence statements and unconfirmed vendor bindings carried in the recipe and validation results.

A recipe completes the integration-planning job. An editor loading successfully does not establish that configuration-driven restrictions took effect; implementation verification should compare behavior with and without the relevant configuration. Keep unconfirmed restrictions visible in the deliverable.

## 10. Learnosity Data Operations

### 10.1 Planning and execution are separate skills

Initially expose `plan_data_job` using the existing recipe capability. The deliverable states the intended operation, prerequisites, paging, write semantics, gotchas, and verification procedure. It explicitly says no live provider operation occurred.

Introduce `query_records`, `export_records`, and `migrate_records` only as the corresponding backend execution handlers are implemented, broker-enforced, and verified. Names here are proposed frontend service skill IDs; actual advertised coverage follows the current implementation. Do not infer support for an operation from a neighboring vendor endpoint or from a recipe's existence.

For executable jobs, require source connection/bank, record family, references or filters, projection, paging policy, limits, consistency expectations, and destination where relevant. Writes also require merge/replace semantics, preservation rules, reference conflicts, and exception handling. A migration binds separate source and destination connections and independently authorizes each.

### 10.2 Reads and exports

The caller must choose one page or all pages to exhaustion. A bounded sample cannot satisfy an all-records request. A record or cost limit reached before exhaustion produces an incomplete result with a resumable checkpoint, not a completed full export.

Use operation-specific pagination from the supported recipe and verified provider contract. Persist the continuation, query digest, page count, processed record identities, and output checkpoints. Do not invent a universal pager across item-bank and session families. After resume, account for repeated pages or records without duplicating the output.

Return an export manifest with query/scope, record count, page count, exhaustion evidence, format, digests, exceptions, and source observation time. State whether the provider supplied a snapshot or the export observed a changing bank. Without snapshot support, completion proves traversal under the documented consistency assumptions, not a point-in-time copy.

Assessment results may contain personal data. Default to the minimum required fields, private artifacts, bounded retention, and redacted diagnostics. Export completion requires both traversal and a retrievable, verified artifact.

### 10.3 Transformations and migrations

Prepare a deterministic plan showing selection, mapping, preservation behavior, expected writes, conflicts, and verification rules. Freeze the selected source revisions or validate them again before writing. Bind execution to the plan digest and the authority granted for both banks.

Never send partial records while assuming merge semantics. Confirm the modeled operation's semantics; if it replaces, retrieve and preserve required fields or reject the incomplete request. Do not use the HTTP verb as evidence of preservation behavior.

Process bounded batches with per-record outcomes and stable operation keys. Checkpoint successful writes and unresolved cases. Read back or otherwise reconcile critical fields and references before reporting success. A clean HTTP response is evidence of acceptance, not necessarily of the requested preservation or completeness.

The default completion contract requires all in-scope records to satisfy the declared rules. Partial success remains visible with counts and a machine-readable exception artifact. Only a request that explicitly permits defined exclusions may complete with those exclusions. No cross-bank transaction or automatic rollback is promised.

### 10.4 Composition with authoring

A frontend authoring service can save its own validated revision through the backend without delegating to a separate public agent. Bulk movement of a collection belongs to Data Operations even if the records originated in authoring.

A request to author content and migrate it creates an explicitly coordinated frontend workflow: authoring produces pinned artifacts; Data Operations consumes their supported portable representation under its own authority. Both services use the backend under their respective execution scopes. Preserve parent/child references and aggregate completion. Internal delegation cannot widen the caller's grants or hide a failed child behind parent success.

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
- One-page reads, exhausted reads, limit stops, resumed exports, replace semantics, conflicts, and partial migrations produce accurate outcomes.
- Cards and tool catalogs advertise only ready skills; target clients handle the selected protocol version, auth, continuation, task retrieval, and artifacts.

Use deterministic provider doubles for failure injection and isolated Learnosity banks for live execution verification. Keep production data out of these checks. The existing no-external-writes baseline remains a regression gate.

## 12. Delivery plan

**Phase 1 — Shared service contracts.** Add the frontend service registry, normalized requests/results, completion validators, and durable parent-job model. Integrate existing frontend generation jobs with writes disabled. Pin portable artifact schemas and define caller identity, scope propagation, and backend enforcement. Exit when service tests prove preparation and planning boundaries independently of either protocol.

**Phase 2 — Learnosity preparation and planning.** Implement the two frontend service configurations and the Learnosity MCP catalog for content, previews, integration recipes, and data plans. Keep provider execution absent from discovery. Exit when representative jobs complete through the frontend runtime and backend compilation/interpretation path with validation and clearly labeled deliverables.

**Phase 3 — A2A pilot.** Add the two frontend cards and one selected HTTP binding for a named target client. Validate discovery, auth, durable task retrieval, clarification, cancellation, and artifacts. Exit after interoperability testing; streaming and push remain separate increments.

**Phase 4 — Provider execution.** First enable explicit authoring saves and bounded read/export operations after backend scope enforcement, receipts, recovery, reconciliation, and frontend completion verification pass live checks. Add transformations and migrations operation by operation. Enable each skill independently in both frontend adapters where supported; a protocol may expose a narrower supported subset without changing service semantics.

**Phase 5 — Packaging and scale.** Use customer installation and administration requirements to decide whether to split MCP endpoints. Add callback delivery, larger workflows, and further domains based on demonstrated demand and measured outcomes.

## 13. Review decisions still needed

- Which target A2A client and protocol/SDK release define the pilot compatibility matrix?
- What public hostnames, card URLs, and MCP distribution channel will the frontend use?
- How will caller-agent identity map to an end-user delegation or a scoped service principal in the existing auth model?
- What frontend scope propagation and backend policy/broker changes are required to enforce the service/job/action scope end to end, and which are deployed?
- Which Learnosity record families and operations are the first executable Data Operations release, and what live verification is available for each?
- What account-specific retention, size, runtime, cost, and approval policies apply to stored results and bulk writes?

- When do the backend's execution observation contracts ship? Specifically: Track E1's event log, interrupts, artifact manifests, error registry and capability declarations, and E4's cursors and agent status. Can backend admission carry the service-scope claim and job deadline that §5 and §6.4 require?

These decisions gate the affected execution features. They do not prevent implementing the shared contracts, content preparation, or documentation-only planning.
