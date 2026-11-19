# Artcompiler Learnosity service contracts and A2A/MCP profile

Status: Draft for review\
Date: November 11, 2026\
Updated: November 17, 2026\
Scope: Artcompiler's Learnosity services, implemented by an installation of `graffiticode-app`\
Basis: [MCP/A2A design brief](./mcp-a2a-design-brief.md)

## 1. Decision

**Artcompiler builds and operates specialized services using the shared `graffiticode-app` frontend and the Graffiticode execution backend.**

Artcompiler owns the services' domain responsibilities, requested deliverables, completion requirements, and customer-facing presentation. The shared frontend implements intent translation, language selection and composition, generation, validation, service jobs, and protocol adapters. The backend supplies controlled compilation, interpretation, capability enforcement, and execution evidence.

For Learnosity, define two services:

- **Assessment Authoring:** create and revise assessment content, validate it, provide previews, and eventually save an explicitly selected revision through an authorized connection.
- **Data Operations:** plan and eventually execute bounded reads, exports, transformations, and migrations of assessment records and collections.

Expose two A2A Agent Cards and initially one **Artcompiler for Learnosity** MCP toolset family with two bounded toolsets, served by the Artcompiler installation (§8). Graffiticode's general-purpose MCP interface retains its existing no-external-writes contract.

This document owns Artcompiler's product and service contracts. The [shared service architecture](./graffiticode-a2a-design.md) owns the runtime, authorization, job lifecycle, outcomes, recovery, and A2A/MCP translation rules. The [installations plan](./installations-plan.md) defines deployment and profile boundaries. Their implementation order and gates are referenced in §12.

## 2. Goals and boundaries

Artcompiler supplies maintained Learnosity expertise, useful generated work, bounded provider operations, and evidence that the requested deliverable is complete. A planning recipe can be a completed service deliverable before provider execution is available; it never proves a live operation occurred.

Authorized customers must be able to inspect the selected revision or plan, validation findings, artifacts, and provider evidence. Machine-checked validity, pedagogical quality judgments, and requested human review remain distinct.

Learner delivery, human-facing reporting, and unrestricted Learnosity administration are outside the initial scope. Embedding Learnosity's authoring UI is an authoring integration-planning skill when supported by an implemented capability; it does not require a third public agent identity.

Public identities group coherent responsibilities. They need not correspond one to one with languages, models, internal agents, or deployments. Cross-service workflows are explicit compositions under the shared runtime (§10.4).

## 3. Installation and implementation boundary

Artcompiler runs the same frontend release as other installations, with its own application database, billing configuration, queues, storage, and credentials under the [installations plan](./installations-plan.md#context). The profile lives in an external, versioned repository. `artcompiler-app` is superseded by this installation model.

The profile supplies branding, legal content, public hosts, service and skill definitions, allowed languages, supported deliverables, limits, and protocol exposure. It selects registered capabilities and their supported parameters. Capability handlers, validator implementations, tier behavior, and security enforcement remain code in the shared release. New behavior requires an implemented capability before a profile can select it.

The [Learnosity skill](../packages/skills/learnosity/SKILL.md) distinguishes content authoring, authoring-UX integration recipes, and data-job recipes. Its recipe capability does not hold provider credentials or execute data jobs. Advertised execution requires the corresponding frontend handlers and backend operations to be implemented, authorized, and verified.

Repository code or a draft definition is not proof of production readiness. Apply the deployment and execution gates in §12 before enabling a skill.

## 4. Service definitions and deliverables

Use the shared [service-definition contract](./graffiticode-a2a-design.md#42-service-definition) and [normalized request/result contract](./graffiticode-a2a-design.md#43-normalized-request-and-result). Artcompiler's versioned definitions select implemented capabilities, constrain their languages and resources, and parameterize registered completion validators for these deliverables:

- **Content:** the selected assessment revision, validation findings, and the requested prepared, previewed, or saved delivery state (§9).
- **Integration recipe:** a host-neutral authoring-UI integration plan, with prerequisites, verification steps, and unconfirmed bindings (§9.3).
- **Data plan:** a bounded operation recipe that explicitly states no live provider operation occurred (§10.1).
- **Operation result:** evidence of the requested read, export, transformation, or migration, including scope, exceptions, and verification (§10).

These requirements drive the same service definitions used by the runtime, MCP catalog, and A2A cards. Public skill IDs describe stable responsibilities rather than language numbers.

## 5. Product action boundaries

Apply the shared [authorization and action boundaries](./graffiticode-a2a-design.md#5-authorization-and-action-boundaries). Artcompiler's definitions narrow each operation to its requested delivery state and selected Learnosity connection, bank, record family, and target scope.

Preparing, revising, previewing, or planning cannot implicitly save or migrate. Saving requires an immutable selected revision, target bank, reference mapping, and overwrite policy. A migration specifies and independently authorizes source and destination. Product-specific requirements are in §9 and §10; the shared architecture governs admission, approvals, scope propagation, and enforcement.

## 6. Shared job and outcome contracts

Artcompiler uses the shared [durable service-job contracts](./graffiticode-a2a-design.md#6-durable-service-jobs) without a separate lifecycle or persistence design. Those contracts govern identifiers, event cursors, interrupts, answer submissions, key retention, save adoption, retries, cancellation, deadlines, and observer jobs.

Use the shared [external-outcome and service-success rules](./graffiticode-a2a-design.md#43-normalized-request-and-result). Backend evidence determines provider outcomes; registered frontend validators assess the requested Artcompiler deliverable against §9 and §10. Timeout and deadline handling comes from [shared §6.4](./graffiticode-a2a-design.md#64-retry-cancellation-and-partial-execution), including pending settlement and adopted executions.

## 7. A2A public identities

Publish **Artcompiler Learnosity Assessment Authoring** and **Artcompiler Learnosity Data Operations** as distinct cards. Proposed application paths are `/agents/learnosity/authoring` and `/agents/learnosity/data`, on the Artcompiler installation's hosts (`*.artcompiler.com`, decided 2026-11-19). Which host serves them, and the routing it supports, are still open.

Generate cards from the same selected service definitions as the MCP catalog. Each identity describes its responsibility, currently available skills, examples, accepted inputs, expected outputs, and connection requirements. A shared host does not widen either service's scope.

Discovery, protocol/SDK version pinning, submission, task retrieval, continuation, cancellation, optional streaming/push, and artifact translation follow the [shared A2A interface](./graffiticode-a2a-design.md#7-a2a-interface). The product's public identities do not introduce additional execution semantics.

## 8. MCP product surface

Start with the **Artcompiler for Learnosity** service tools: two bounded toolsets on one MCP endpoint of the Artcompiler installation, `mcp.artcompiler.com`. The current release serves the generic item tools at `/mcp` for every installation, and the service tools at a path of their own (for example `/learnosity/mcp`). So the installation has two MCP endpoints on one host until the release can serve both families together. Proposed authoring tools are `assessment_create_item` and `assessment_update_item`; previews come from the shared `render_item`, since the registry has no preview operation. Add `assessment_save_item` only when provider execution is ready. Proposed data tools are `data_plan`, then `data_query`, `data_export`, and eventually `data_migrate` as their handlers become available.

Shared `job_get`, `job_continue`, and `job_cancel` and any negotiated MCP Tasks support follow the [shared MCP interface](./graffiticode-a2a-design.md#8-mcp-interface-and-compatibility). Tool names and descriptions come from the profile's selected skills; annotations and available tools must match implemented behavior and current authorization.

Split the product into separate MCP endpoints when authoring and data operations require independent customer installation, administration, access arrangements, distribution, or operational isolation. A client that trusts only entire connections is a concrete reason to split. The service IDs and shared execution contracts remain the same.

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

## 11. Product verification

Apply the [shared operational and failure-recovery verification](./graffiticode-a2a-design.md#11-operational-behavior-and-verification). In addition, demonstrate the Artcompiler completion contracts:

- Prepared content satisfies the requested structure, scoring, references, and content constraints; preview and saved states have their required evidence.
- Instructions to save inside a create, revise, or preview request cannot cause an item-bank write. Data planning cannot invoke a provider operation.
- Integration recipes preserve unconfirmed configuration restrictions and specify how to verify them.
- One-page reads, exhaustive reads, limit stops, and resumed exports report the actual processed scope and produce retrievable, verified artifacts.
- Merge/replace behavior, preservation rules, reference conflicts, exclusions, and partial migrations are tested against the requested contract.
- An authoring-and-data workflow preserves pinned artifacts and authority boundaries and cannot hide a failed child behind parent success.
- Equivalent requests through MCP and A2A produce the same domain validation findings and completion evidence.

Use deterministic provider doubles for failure injection and isolated Learnosity banks for live provider verification. Keep production data out of these checks. Apply the minimum-field, private-artifact, and retention requirements in §10 to assessment results.

## 12. Delivery dependencies

Implementation scheduling and readiness gates live in two plans:

- The [execution observation plan](https://github.com/graffiticode/graffiticode/blob/main/docs/execution-observation-plan.md) governs shared service jobs, backend observation and execution dependencies, and the A2A pilot. Its D-1 to D-6 decisions apply through the shared architecture.
- The [installations plan](./installations-plan.md) governs external profiles, capability selection, service-tool generation, storage and authorization isolation, and deployment of the Artcompiler installation. P4 covers the generic service-tool family; P6 defines the Artcompiler acceptance deployment and its P5 prerequisites.

These plans determine when preparation, planning, A2A, and individual execution skills can ship. This product document defines what each service must deliver; it does not maintain a parallel phase schedule. Recipe capability never opens an execution gate.

## 13. Product decisions still needed

- Which target A2A client and integration scenario should the Artcompiler pilot serve, under the shared protocol compatibility requirements?
- Which installation host serves the Agent Cards, at which card URLs, and through which MCP distribution channel? The hostnames themselves are decided: one installation on `console.`, `app.`, `mcp.` and `api.artcompiler.com`, with product sites such as assessments.artcompiler.com as marketing funnels.
- Which Learnosity record families and operations form the first executable Data Operations release, and what live verification is available for each?
- What customer-specific retention, size, runtime, cost, consistency, and approval requirements apply to stored results and bulk operations?
- When do customer trust or administration requirements justify separate authoring and data MCP endpoints?

Shared identity delegation, service-scope enforcement, backend prerequisites, and protocol decisions remain in the [shared design's open decisions](./graffiticode-a2a-design.md#13-review-decisions-still-needed) and the implementation plans. Affected skills stay gated until their dependencies and product requirements are resolved.
