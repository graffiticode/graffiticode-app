# Artcompiler A2A services and Learnosity agents

Status: Draft for review  
Date: November 11, 2026  
Basis: [MCP/A2A design brief](./mcp-a2a-design-brief.md)

## 1. Decision

**Artcompiler builds and operates specialized micro-agents. Graffiticode supplies the platform for the controlled execution of their work and inspection of the results.**

Each Artcompiler service accepts responsibility for a bounded outcome. Artcompiler is responsible for the service's domain expertise, generated work, and completion contract. Its micro-agents use Graffiticode's shared intent translation, language composition, generation, compilation, execution, capability enforcement, and result inspection mechanisms. A2A and MCP are interfaces to these Artcompiler services.

For Learnosity, define two services:

- **Assessment Authoring:** create and revise assessment content, validate it, provide previews, and eventually save an explicitly selected revision through an authorized connection.
- **Data Operations:** plan and eventually execute bounded reads, exports, transformations, and migrations of assessment records and collections.

Expose two A2A Agent Cards and initially one **Artcompiler for Learnosity** MCP endpoint with two bounded toolsets. Keep the existing general Graffiticode MCP product and its no-external-writes contract intact. The proposed Learnosity MCP endpoint is a distinct product surface; adding it does not silently add writes to existing tools.

Define service scope, execution contracts, and verification once. Both adapters call these definitions directly. An A2A request does not need an additional model that forwards it through MCP.

The initial release offers only capabilities that can be demonstrated end to end. Data-job recipes can ship before data execution; a recipe is a completed planning deliverable, never evidence of a completed provider operation.

## 2. Goals and boundaries

The general architecture must support additional Artcompiler domains without rebuilding authentication, job tracking, clarification, artifact delivery, or recovery. A new service should primarily supply its supported intents, language constraints, provider operations, and completion validators.

Artcompiler earns delegation by supplying maintained capability: appropriate generation, reliable execution, constrained provider access, and evidence of the outcome. A2A itself does not make the underlying work more intelligent or reliable.

The micro-agents exist to do useful work that is **secure, transparent, and accessible**:

- **Secure:** Artcompiler defines each service's scope; execution is constrained by that scope, the caller's grants, and connection policy, with protected operations enforced by policy and broker.
- **Transparent:** authorized users can inspect the selected revision or plan, output artifacts, validation results, provenance, and provider evidence where applicable. Uncertainty and incomplete outcomes remain visible.
- **Accessible:** clients can discover and use supported capabilities through A2A and MCP, obtain clarification when needed, and retrieve usable results through documented contracts.

An Artcompiler micro-agent is defined here by its bounded responsibility and observable results. Internal composition and delegation are implementation choices. This design does not require one model, language, internal micro-agent, or deployment per public agent. It does not introduce a general autonomous multi-agent scheduler. Cross-service workflows begin as explicit compositions with recorded child jobs and authority boundaries.

Learner delivery, human-facing reporting, and unrestricted Learnosity administration are outside the initial service scope. Embedding Learnosity's authoring UI is an authoring integration-planning skill when supported by a current language; it does not require a third public identity.

## 3. Current foundation and implementation gaps

This section describes repository evidence, not production deployment status.

The app already has a shared domain package, [`packages/core`](../packages/core/package.json), used by protocol-facing code. Its generation lifecycle provides durable job envelopes, leases, recovery, revision checks, version records, and effect intents. See [`generation-jobs.ts`](../packages/core/src/generation-jobs.ts), [`effects.ts`](../packages/core/src/effects.ts), and [`idempotency.ts`](../packages/core/src/idempotency.ts). Reuse these mechanisms rather than introducing a second generation engine.

The existing MCP authoring backend passes a trusted `externalWrites: false` argument. The generation worker skips connection lookup and connection-write effects for these jobs regardless of language routing. [`core-backend.ts`](../packages/mcp-server/src/core-backend.ts) and the [baseline contract tests](../tests/baseline/mcp-no-external-writes.test.ts) make this an explicit guarantee. Existing `create_item` and `update_item` must retain it.

The repository's [Learnosity skill](../packages/skills/learnosity/SKILL.md) distinguishes content authoring, authoring-UX integration recipes, and data-job recipes. In particular, the data-job language does not hold credentials or call Learnosity. Existing generation cannot be relabeled as a data execution service.

Connection writes and reconciliation already have app-tier integration points in [`writes.ts`](../packages/core/src/writes.ts). The [policy design as built](../packages/console/docs/capability-policy-as-built.md) describes compiler admission checks, policy snapshots, execution tokens, broker receipts, and private artifacts across companion repositories. That document contains historical branch and release caveats; it is architectural context, not proof that every prerequisite is deployed today.

New work includes service definitions and enforced scope attenuation, a durable service-job lifecycle above generation jobs, A2A adapters, a Learnosity-specific MCP catalog, and operation-specific execution and verification for Data Operations. Deployment readiness of policy, broker, registry, compiler, and gateway must be demonstrated before enabling provider execution.

## 4. General service architecture

### 4.1 Components and ownership

**Artcompiler service registry.** Stores reviewed, versioned service definitions. Owns stable service and skill identifiers, supported requests, allowed language compositions, maximum provider capabilities, output contracts, and completion criteria. Deployment configuration enables a subset of implemented skills.

**Protocol adapters.** Authenticate requests, resolve the selected service, validate protocol payloads, and translate messages, job state, and artifacts. They own transport behavior and client compatibility. They do not contain Learnosity business logic.

**Artcompiler service runtime.** Resolves caller context, interprets the requested outcome, requests missing information, constructs a bounded plan, reserves work, and evaluates completion. The runtime may use existing generation and routing. Every resulting language and operation remains constrained by service scope.

**Graffiticode platform.** Supplies shared intent translation, language composition, generation, compilation, controlled execution, and capability enforcement machinery for Artcompiler's micro-agents. Job records, artifacts, and verification evidence support authorized inspection of the work and results. Compilation is one stage of a service job. Its successful completion alone does not prove a provider write or a complete export; Artcompiler evaluates the resulting evidence against the service's completion contract.

**Policy and broker.** Enforce provider access at the operation boundary and perform credentialed calls. The console remains the place for detailed connection and capability management. Artcompiler stores connection references, not provider secrets in prompts or job artifacts.

**Job and artifact stores.** Persist the service-level conversation, requested deliverable, child generation jobs, execution checkpoints, results, and evidence. Workers and adapters operate against this durable state; an open HTTP stream is never its source of truth.

The request path is: adapter → Artcompiler service runtime → controlled Graffiticode execution → policy/broker operations → verification → durable, inspectable result → adapter. A card or tool catalog is generated from the same service definition used by the runtime.

### 4.2 Service definition

Each definition contains:

- Stable `serviceId`, definition version, public name, responsibility, and explicit exclusions.
- Skills with stable IDs, examples, required context, input schemas, output schemas, and deliverable kinds.
- Allowed languages and composition rules, plus protected functions and broker operations available to each skill.
- Supported connection backends and resource constraints, including bank and record scope where enforceable.
- Completion validators and required evidence for each requested delivery state.
- Limits for elapsed time, generation attempts, records, bytes, provider calls, and cost.
- Protocol exposure settings and deployment feature gates.

Skill availability is the intersection of implemented handlers, ready dependencies, service configuration, and caller authorization. A definition must not advertise execution merely because a planning language describes that operation.

Pin the definition version for an accepted job. Recheck live authorization when work resumes and at protected operations. Version pinning preserves interpretation; it does not freeze grants after revocation.

### 4.3 Normalized request and result

The internal request carries `serviceId`, authenticated principal and account boundary, optional conversation and job references, intent, input artifact references, requested deliverable, connection reference, constraints, and an idempotency key. Account identity is derived from verified authentication, never accepted from message text.

`deliverableKind` distinguishes `content`, `integration_recipe`, `data_plan`, and `operation_result`. An operation request further specifies its required delivery state, such as prepared, saved, or exported. These are Artcompiler domain fields, not claimed A2A standard fields.

A result carries a concise summary, artifact references, scope processed, verification evidence, warnings, and unresolved exceptions. Persist an explicit external outcome such as `not_requested`, `not_started`, `applied`, `partially_applied`, or `unknown`. Never translate an unknown provider outcome into success.

## 5. Authorization and action boundaries

Use the brief's rule:

**Effective capabilities = service scope ∩ console grants ∩ connection policy.**

For each operation, narrow this further to the requested action and target resources. A preview request remains unable to save even if the principal owns a connection with write permission. A Data Operations identity cannot invoke every broker operation just because the caller's connection permits them.

The existing trusted `externalWrites: false` argument demonstrates a useful restriction but is not a complete service policy. Provider-enabled jobs need a trusted, server-created execution scope bound to service, job, principal, connection, permitted actions, resource limits, and policy version. Carry that binding through the execution context to policy and broker enforcement. If downstream policy cannot enforce the restriction, that execution skill remains disabled. Prompt instructions and filtered catalogs are insufficient.

Resolve and bind a connection before execution. Never switch to a newly selected default connection during recovery. Check ownership or delegation, provider account, active status, and operation permissions. Authentication of a calling agent does not by itself establish authority to act for an end user; use an existing verified delegated identity or a separately scoped service principal.

Calls to read, resume, cancel, or retrieve artifacts require the same account and service ownership checks as submission. Job IDs, A2A context IDs, and artifact URLs are identifiers, not grants. Public cards reveal no tenant-specific bank details. Shared contexts do not imply shared authorization.

Content preparation cannot become a provider write through natural-language revision. For a write-capable service, explicit requested delivery state and permitted scope authorize the action. If connection policy requires additional approval, pause with a concrete plan identifying target bank, revision, scope, and expected changes. Existing authorization can satisfy this requirement; avoid redundant approvals. Bind any approval to the plan digest and invalidate it when material scope changes.

## 6. Durable service jobs

### 6.1 Distinct identifiers

An **Artcompiler service job** tracks responsibility for an outcome. An **A2A task** is that job's protocol representation. An **MCP extension task**, when supported, is another representation. A **generation job** runs one generation or revision stage. A Graffiticode **Task = (lang, code)** identifies language work.

Persist explicit mappings; do not overload `taskId`. A service job may reference several generation jobs, Graffiticode tasks, provider invocations, and artifacts. Protocol IDs are scoped to the relevant adapter, account, and service.

### 6.2 Persistence

Introduce a service-job record, provisionally `service-jobs/{jobId}`, with:

- Immutable service/version, principal/account, accepted intent, deliverable, connection, limits, input digests, and creation time.
- Mutable state and revision, deadline, cancellation request, waiting question and continuation token, and current plan revision.
- Child-generation references, provider invocation IDs, operation checkpoints, and artifact manifests.
- Completion or failure details, verification results, and external outcome.

Persist events with monotonic per-job sequence numbers. Commit transitions and their dispatch intents atomically, then use the existing outbox/lease pattern for delivery. Generation remains in `generation-jobs`; the parent job does not copy or independently mutate its dispatch state.

Do not store bearer tokens for replay. Resume work using the existing bounded grant model where applicable and current policy checks. Inputs and outputs containing assessment results require access-controlled storage, configured retention, and deletion behavior.

### 6.3 Lifecycle and clarification

Internal lifecycle: `accepted` → `working` → `completed` or `failed`. `working` may pause at `input_required` or `auth_required`, then resume. `rejected` describes a task-level refusal under the selected protocol; malformed or unauthenticated requests can fail before job creation. `canceled` is terminal only after work has stopped or been safely fenced.

Clarification records the specific missing fact, expected answer shape, affected plan revision, and expiry. Answers must name the existing job and current question, pass ownership checks, and be applied once. Missing bank identity or deployment details must not be guessed. New requirements that change a completed deliverable create a new job linked to the same conversation.

A2A maps these states through the selected SDK's task-state enum. MCP Tasks-extension execution maps to its supported states; authentication handling remains in the MCP adapter. Without the extension, return a domain job handle and use explicit status/continuation tools. Do not claim those handles are MCP protocol tasks. A status result must preserve the original requested deliverable and any unresolved external outcome.

### 6.4 Retry, cancellation, and partial execution

Scope idempotency to account, principal, service, operation, and client key, and bind it to an input digest. The same key and digest returns the existing job; different input is a conflict. A retry through another interface reaches the same job only when the caller explicitly supplies the shared domain key and passes ownership checks. Conversation IDs alone do not deduplicate work.

Assign deterministic child-step identities and provider operation keys. Reuse them after worker crashes or lost responses. Reuse existing gateway and broker invocation/receipt semantics where available. Exactly-once external execution is not assumed.

A provider timeout after submission can mean the write happened. Mark the operation unknown, reconcile using provider references and supported readback, and block blind replay. Reconciliation itself requires authorization. A new key must never be silently generated to get past an uncertain receipt.

Cancellation is cooperative: stop scheduling, check cancellation between bounded operations, and report committed changes. It does not undo provider writes. Keep the job nonterminal while an in-flight effect can still commit. If an effect cannot be resolved before the job deadline, terminate as failed with external outcome unknown and preserve the reconciliation path. Compensation requires an explicit, separately authorized plan.

## 7. A2A interface

### 7.1 Identities, discovery, and versioning

Publish **Artcompiler Learnosity Assessment Authoring** and **Artcompiler Learnosity Data Operations** as distinct cards. Proposed application paths are `/agents/learnosity/authoring` and `/agents/learnosity/data`; their exact host is a deployment decision.

The cards identify the services Artcompiler builds and operates. Graffiticode is their execution and result inspection platform. Each public identity groups a coherent responsibility and its supported skills; internal languages and micro-agents do not automatically receive separate cards. An A2A endpoint is a protocol access point. The [A2A core concepts](https://a2a-protocol.org/latest/topics/key-concepts/) allow a remote agent to be an agent or agentic system, so an endpoint does not determine whether its implementation performs work directly or delegates internally.

Use directly configured card URLs or a catalog to discover both identities on a shared host. The standard root `/.well-known/agent-card.json` returns a single Agent Card; do not put an Artcompiler card array there. If root discovery is required for each identity, use separate hostnames or another supported routing arrangement.

Each card describes responsibility, currently enabled skills, examples, input/output media types, security requirements, and supported interfaces. Pin an A2A release and SDK together; validate cards and payloads against that release. Keep protocol version, service-definition version, and artifact-schema version separate. The current [A2A specification](https://a2a-protocol.org/latest/specification/) defines cards, task interaction, artifacts, discovery, and transport bindings; `latest` is a research link, not a deployment version pin.

Start with one HTTP binding, durable task retrieval, multi-turn continuation, and cancellation. Add streaming when a target client needs it; add push after authenticated callback delivery and retry behavior are implemented. Advertise optional features only after interoperability checks. Hosting both identities together does not grant either identity the other's scope.

### 7.2 Messages and artifacts

Accept natural-language intent with optional structured domain input. Return messages for clarification and progress; return artifacts for deliverables. Use plain text or Markdown for recipes and summaries, JSON for structured assessment payloads and manifests, and downloadable files for exports. Preview links are optional authenticated conveniences; completion must remain understandable to clients without Graffiticode widgets.

Domain artifact manifests include schema version, content type, digest, provenance, service-job ID, relevant content revision, delivery state, and verification references. Resolve artifacts through authorized retrieval or narrowly scoped expiring URLs. Do not expose language-private ASTs as a general cross-service contract; use a platform-neutral spec when moving intent between languages.

## 8. MCP interface and compatibility

The Learnosity-specific MCP catalog uses stable, explicit names. Proposed authoring tools are `assessment_create_item`, `assessment_update_item`, and `assessment_preview_item`; add `assessment_save_item` only after provider execution is ready. Proposed data tools are `data_plan`, then `data_query`, `data_export`, and eventually `data_migrate` as their handlers mature. Shared `job_get`, `job_continue`, and `job_cancel` cover the fallback job interface.

Each tool accepts rich intent within its named purpose. Save requires an immutable content revision and selected connection. A planning call cannot execute merely because its description includes execution instructions. Migration cannot be hidden in a read tool. Tool descriptions and side-effect annotations must match actual behavior.

Filter discovery by authorization, and recheck authorization at invocation. MCP supports authorization-dependent tool catalogs; grouping into two toolsets is Artcompiler configuration, with no assumption that every client exposes group toggles. See the [MCP tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).

Use the [MCP Tasks extension](https://github.com/modelcontextprotocol/ext-tasks/blob/main/specification/2026-07-28/tasks.md) only when negotiated and implemented. Client compatibility determines whether clarification uses elicitation, task-associated interactions, or explicit continuation. These are adapter choices over one service job.

Initially deploy one Learnosity endpoint. Split it when authoring and data operations need independent installation, administration, access arrangements, distribution, or operational isolation. A client that trusts only entire connections is a concrete reason to split. Both endpoints would retain the same service IDs and execution rules.

## 9. Learnosity Assessment Authoring

### 9.1 Supported responsibility

Accept subject, audience, quantity, question and activity structure, scoring intent, feedback, accessibility requirements, metadata, and requested delivery state. Use current language descriptions and scope metadata to select content authoring or integration planning; public skill IDs must not encode a remembered language number.

For content, the Artcompiler micro-agent generates or revises through Graffiticode, validates structure, item/activity references, scoring configuration, and requested content constraints, and provides a preview where available. Separate machine-checked validity from pedagogical quality judgments and any requested human review. A successful render does not prove the scoring model or all requested restrictions are correct.

Content stages are:

1. **Prepared:** the selected revision exists, required checks pass, and any warnings are explicit.
2. **Previewed:** that revision has a usable preview; no item-bank write is implied.
3. **Saved:** the authorized save of that revision has confirmed provider evidence and returned item/activity references.

Complete against the requested stage. If the caller requested a save, preparation alone is an intermediate result. Saving does not imply publication or learner delivery.

### 9.2 Save execution

Prepare and validate with writes disabled. Bind save to the immutable generated artifact, target connection/bank, reference mapping, overwrite policy, and requested state. Execute the reviewed operation through policy and broker, persist the receipt, and verify the resulting references and content where provider support permits. Any generation after review produces a new revision requiring renewed validation and action binding.

Use optimistic concurrency for revisions and provider preconditions where available. When provider conditional writes are unavailable, declare the concurrency limitation and avoid claiming atomic overwrite protection.

Do not reuse the console's automatic write-through behavior as an implicit consequence of authoring. The service's provider action must be an explicit, constrained stage. Add tests showing that an instruction to save inside a create, revise, or preview request still cannot write.

### 9.3 Authoring integration planning

When a supported language models embedding an item editor, browser, or activity editor, produce a host-neutral recipe. Require actual deployment facts such as serving domain, author identity, bank, and relevant references. Preserve the backend's confidence statements and unconfirmed vendor bindings.

A recipe completes the integration-planning job. An editor loading successfully does not establish that configuration-driven restrictions took effect; implementation verification should compare behavior with and without the relevant configuration. Keep unconfirmed restrictions visible in the deliverable.

## 10. Learnosity Data Operations

### 10.1 Planning and execution are separate skills

Initially expose `plan_data_job` using the existing recipe capability. The deliverable states the intended operation, prerequisites, paging, write semantics, gotchas, and verification procedure. It explicitly says no live provider operation occurred.

Introduce `query_records`, `export_records`, and `migrate_records` only as broker-backed handlers are implemented and verified. Names here are proposed service skill IDs; actual advertised coverage follows the current implementation. Do not infer support for an operation from a neighboring vendor endpoint or from a recipe's existence.

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

An authoring service can save its own validated revision without delegating to a separate public agent. Bulk movement of a collection belongs to Data Operations even if the records originated in authoring.

A request to author content and migrate it creates an explicitly coordinated workflow: authoring produces pinned artifacts; Data Operations consumes their supported portable representation under its own authority. Preserve parent/child references and aggregate completion. Internal delegation cannot widen the caller's grants or hide a failed child behind parent success.

## 11. Operational behavior and verification

Record service/job IDs, definition version, adapter, generation references, policy decisions, operation/receipt IDs, state transitions, verification outcomes, and resource usage. Keep secrets, full prompts, assessment answers, and result payloads out of routine logs. Provide tenant-scoped audit access separately from operational metrics.

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

**Phase 1 — Shared service contracts.** Add the registry, normalized requests/results, completion validators, and durable parent-job model. Integrate existing generation jobs with writes disabled. Pin portable artifact schemas and define caller identity and service-scope enforcement. Exit when service tests prove preparation and planning boundaries independently of either protocol.

**Phase 2 — Learnosity preparation and planning.** Implement the two service configurations and the Learnosity MCP catalog for content, previews, integration recipes, and data plans. Keep provider execution absent from discovery. Exit when representative jobs complete with validation and clearly labeled deliverables through the shared runtime.

**Phase 3 — A2A pilot.** Add the two cards and one selected HTTP binding for a named target client. Validate discovery, auth, durable task retrieval, clarification, cancellation, and artifacts. Exit after interoperability testing; streaming and push remain separate increments.

**Phase 4 — Provider execution.** First enable explicit authoring saves and bounded read/export operations after scope enforcement, receipts, recovery, reconciliation, and live verification pass. Add transformations and migrations operation by operation. Enable each skill independently in both adapters where supported; a protocol may expose a narrower supported subset without changing service semantics.

**Phase 5 — Packaging and scale.** Use customer installation and administration requirements to decide whether to split MCP endpoints. Add callback delivery, larger workflows, and further domains based on demonstrated demand and measured outcomes.

## 13. Review decisions still needed

- Which target A2A client and protocol/SDK release define the pilot compatibility matrix?
- What public hostnames, card URLs, and MCP distribution channel will Artcompiler use?
- How will caller-agent identity map to an end-user delegation or a scoped service principal in the existing auth model?
- What policy/broker changes are required to carry and enforce the service/job/action scope end to end, and which are deployed?
- Which Learnosity record families and operations are the first executable Data Operations release, and what live verification is available for each?
- What account-specific retention, size, runtime, cost, and approval policies apply to stored results and bulk writes?

These decisions gate the affected execution features. They do not prevent implementing the shared contracts, content preparation, or documentation-only planning.
