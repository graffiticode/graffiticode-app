**Design recommendation — November 9, 2026**

Use Graffiticode as the shared intent execution engine for two Artcompiler Learnosity services: **Assessment Authoring** and **Data Operations**. Expose those services through **two A2A Agent Cards** and, initially, **one Artcompiler for Learnosity MCP server with two bounded toolsets**.

Maintain service definitions, capability enforcement, and execution behavior independently of either protocol. Changing how customers discover or connect to the services should not require rebuilding the underlying capabilities.

# Architectural premise

General intelligence can coexist with distributed capability. A powerful agent may understand how to perform a task while another organization controls the necessary information, permissions, maintained integrations, or operational infrastructure. Delegation can be part of how that agent solves the problem.

A2A supports collaboration among independently operated agent systems whose internal state and tools may remain private. It does not establish that multiple agents are always better or that a general agent could never perform the same work. See [A2A purpose and design principles](https://a2a-protocol.org/latest/topics/what-is-a2a/).

Artcompiler’s durable value should come from maintaining and operating specialized capabilities: translating intent into suitable work, enforcing constraints, executing reliably, and verifying outcomes. A specialist must justify its coordination cost through useful capability, quality, speed, or lower total operating cost.

# Separation of responsibilities

| Layer | Responsibility |
| - | - |
| Graffiticode platform | Provide the general machinery for translating intent into language-specific work and processing it through shared compilation, execution, and capability enforcement. |
| Artcompiler services | Define the responsibility accepted from the caller, supported requests, permitted capabilities, working context, and completion criteria. |
| MCP interface | Expose those capabilities through named tools that can accept natural-language intent. |
| A2A interface | Expose the services as discoverable agents with a common message, job-status, and result-exchange contract. |

Multiple external agent identities can share one Graffiticode deployment. An advertised agent can use several languages or internal micro-agents, and several advertised agents can reuse the same language implementations. Public agents, internal micro-agents, languages, models, and deployments do not need to correspond one to one.

# Learnosity service boundaries

## Assessment Authoring

Accept responsibility for creating and revising assessment content: questions, scoring, feedback, activities, previews, and authorized saving. Define completion in terms of the requested content, its validation, and the requested delivery state.

Related operations should remain skills or tools within this service. Creating, revising, previewing, and saving an assessment do not each require a separate public agent.

## Data Operations

Accept responsibility for operations on assessment data and collections, such as querying, exporting, transforming, or migrating records. Define completion in terms of the requested scope, preservation requirements, handled exceptions, and verification of the resulting state.

Use **Data Operations** as the customer-facing responsibility. The Learnosity Data API is an implementation surface; API boundaries need not determine product boundaries. Both services may reuse underlying operations.

Keep these as separate logical services because their callers, permissions, working context, and success criteria can differ. Their eventual supported operations should reflect capabilities that Artcompiler can actually execute and verify.

# MCP and A2A functionality

Graffiticode already accepts natural-language intent through MCP tools. Adding A2A therefore does not create the ability to delegate goals, use specialized reasoning, or execute external operations. Those abilities reside in the service implementation.

MCP exposes named tools with declared inputs and results. Its current specification supports requests for additional input, and its Tasks extension supports deferred execution and job tracking. Long-running work and clarification are therefore not exclusive to A2A. See the [MCP tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) and [MCP Tasks extension](https://github.com/modelcontextprotocol/ext-tasks/blob/main/specification/2026-07-28/tasks.md).

A2A standardizes agent descriptions, messages associated with conversation contexts and tasks, and deliverable artifacts. Streaming and push notifications are optional advertised capabilities. See [A2A core concepts](https://a2a-protocol.org/latest/topics/key-concepts/).

The practical difference is the interaction contract understood by the caller. Actual client and server support determines which features are usable. Both interfaces should call the same scoped Artcompiler services; an additional LLM that merely forwards A2A requests through MCP is not required.

# Recommended external interfaces

## Two A2A identities

Publish one Agent Card for **Artcompiler Learnosity Assessment Authoring** and another for **Artcompiler Learnosity Data Operations**. Each card should describe its responsibility, relevant skills, example requests, accepted inputs, expected outputs, and connection requirements.

Bind each identity to its service configuration through explicit routing. Separate paths or another supported routing mechanism can select the service while sharing one host and implementation. A2A explicitly supports multiple agents behind shared endpoints; the operator defines the routing. See [A2A multi-agent routing](https://a2a-protocol.org/latest/topics/multi-tenancy/).

A single Learnosity agent advertising both skill groups is also valid, but two identities better express the independently delegable responsibilities selected here.

## One MCP server with two toolsets

Start with one **Artcompiler for Learnosity** MCP connection. Organize its tools into Assessment Authoring and Data Operations, using stable names and descriptions that remain clear in a combined catalog.

Illustrative tools include:

- **Assessment Authoring:** `assessment_create_item`, `assessment_update_item`, `assessment_preview_item`, and `assessment_save_item`.

- **Data Operations:** `data_query`, `data_export`, `data_migrate`, and `data_get_job`.

Each tool should accept a rich intent within a bounded purpose. Preserve clear distinctions between preparing content and saving it, and between reading data and changing it. These tool names are examples, not a complete interface specification.

Treat toolsets as Artcompiler’s configuration groups. Do not depend on every MCP client displaying or enabling those groups independently. The protocol permits authorization-dependent tool catalogs, so an authoring-only caller can receive a narrower tool list than a caller authorized for both services. See [MCP tool discovery and authorization](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).

# Shared service configuration and capability enforcement

Define each service once, with:

- Its identity, routing, supported intents, and advertised skills.

- The Graffiticode languages and operations available within its scope.

- Its working context and permitted provider connections.

- Its output expectations and criteria for successful completion.

Use those definitions to drive both MCP exposure and A2A exposure. Preserve Graffiticode’s console as the place where detailed capability grants are managed; clients should not need to understand every dialect-level permission.

**Effective capabilities = service scope ∩ console grants ∩ connection policy**

Apply those limits through Graffiticode’s policy and broker path when operations are attempted. Tool catalogs, tool descriptions, and Agent Cards describe capabilities; they do not grant them. A2A likewise leaves authorization to server policies governing requested skills, actions, and data access. See [A2A authorization responsibilities](https://a2a-protocol.org/latest/specification/#75-server-authorization-responsibilities).

Equivalent requests under the same service, caller grants, and connection policy should receive the same authorization decision through either protocol. A preview request must remain a preview even when the underlying engine can also save content or perform migrations.

# Request execution and job state

A request should follow this conceptual flow:

1. The interface identifies the Artcompiler service and authenticated caller.

2. The service resolves the request’s context and effective capabilities.

3. Graffiticode selects the appropriate language-specific machinery and processes the intent within that scope.

4. Shared execution state supplies any clarification requests, progress, results, and verification evidence.

5. The interface presents that state using its MCP or A2A conventions.

Keep domain execution logic below the protocol adapters. Neither protocol supplies the persistence, recovery behavior, or outcome verification required to make execution reliable.

An A2A task or MCP Tasks-extension task represents a tracked delegated job. Graffiticode’s **Task = (lang, code)** is a different object. A job may reference several Graffiticode tasks or items during its lifetime. Protocol completion should reflect the service’s completion criteria, rather than merely the production of generated code.

# When to split the MCP endpoints

Expose separate Assessment Authoring and Data Operations MCP endpoints when customers need independent installation or administration, different access arrangements, separate product distribution, or distinct operational requirements.

A particularly strong reason is a client whose main unit of configuration and trust is the entire MCP connection. Separate endpoints may then provide a clearer experience than one authorization-dependent catalog. A large or ambiguous combined catalog is another reason to reconsider the packaging.

Those endpoints can still share the same implementation and engine. The service boundary and enforcement model should remain stable.

The starting arrangement is therefore **one MCP server, two bounded toolsets, two A2A identities, and shared service definitions**. If authoring and data operations are already intended to be separately installed and administered products, expose two MCP endpoints from the outset.

# Implementation priorities

First, define the two service configurations and their supported operations, capability scopes, outputs, and completion criteria. Then map the existing intent-based MCP interface onto those configurations.

Add A2A interfaces when a target client or integration benefits from its discovery and coordination conventions. Connect them to the same service and execution state, preserving the distinctions between generated content, requested external actions, and verified outcomes.

Before committing to advanced interaction features, check the target clients’ support for clarification, asynchronous tasks, notifications, and component presentation. Keep protocol adapters and tool catalogs modular so additional interfaces or separate endpoints remain packaging changes.
