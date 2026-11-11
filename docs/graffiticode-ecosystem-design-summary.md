# Graffiticode Ecosystem Design Summary

**Date:** November 11, 2026  
**Scope:** Summary of this conversation, including the architectural direction, initial interface recommendations, shared hosting model, pricing, proposed foundation, and security responsibilities.  
**Status:** Design direction and recommendations. Proposed domains, services, pricing policies, and legal structures are not presented as deployed or established.  
**Terminology:** “gc.org” is used here as shorthand for the shared service at **graffiticode.org**; it does not imply ownership or deployment of the literal gc.org domain.

## Executive summary

The discussion developed a model in which Graffiticode supplies open-source execution infrastructure, a shared hosted service operates that infrastructure, and commercial front-end vendors build differentiated products above it.

Artcompiler would be one such vendor. Its applications, MCP tools, and A2A agents would own the interpretation of user intent and all code generation. They would submit programs to Graffiticode for controlled compilation and execution. Other vendors could use the same backend and the same community languages.

Languages hosted on the shared service would be required to be open source. Vendors that need proprietary language implementations could host their own infrastructure. Front-end applications and generators could remain proprietary, and customer programs and data would retain their own access rules.

The preferred economics are usage-based: charge for execution and allocate an upfront contribution toward preserving newly retained artifacts. Permanent retention would allow older artifacts to move into cold storage; retrieval speed would be a separate service commitment.

A nonprofit foundation was proposed to steward the service, adjust prices according to sustainable costs, and maintain a preservation fund or trust. Its central operational purpose would include pooling the difficult, continuing work of security into an openly inspectable platform with funded, accountable maintainers.

> Front-end vendors compete on the quality of their products. The shared service provides controlled execution, dependable operation, and long-term preservation.

## 1. Decisions, recommendations, and proposals

| Topic | Direction from the conversation | Status |
| --- | --- | --- |
| Platform and products | Graffiticode supplies the execution platform; Artcompiler and other vendors supply products above it. | Established direction |
| Shared hosting | Artcompiler can use graffiticode.org as its backend. | Preferred model |
| Code generation | Every vendor owns its generation process, including when targeting community languages. | Explicit user direction |
| Hosted languages | Language implementations must be open source to be hosted on gc.org. | Explicit user direction |
| Proprietary languages | Vendors can run them on their own infrastructure. | Explicit user direction |
| Differentiation | Front ends compete on quality of service, broadly understood. | Explicit user direction |
| Learnosity A2A | Begin with Assessment Authoring and Data Operations as two logical services. | Initial recommendation |
| Learnosity MCP | Begin with one server exposing two clearly bounded toolsets. | Initial recommendation |
| Domains | Put Artcompiler product interfaces under artcompiler.com; retain shared infrastructure under graffiticode.org. | Proposed naming arrangement |
| Pricing | Use usage charges, with an upfront contribution for newly retained artifacts. | Direction plus pricing recommendation |
| Preservation | Retain artifacts permanently while allowing access speed and storage tier to change. | Explicit user direction |
| Foundation and trust | Use nonprofit stewardship and a dedicated preservation funding arrangement. | Favored proposal; legal structure unresolved |
| Security | Pool security engineering and hosting operations in a well-funded open-source institution. | Central strategic rationale |

## 2. Why A2A remains useful with powerful general agents

A2A does not depend on proving that a sufficiently capable general-purpose model cannot solve a problem. The practical premise is that useful capabilities are distributed.

A model's reasoning ability does not itself provide credentials, customer-specific permissions, operational ownership, integration maintenance, or access to another organization's execution environment. A specialized service can combine those capabilities with domain knowledge and a clear service commitment.

For Graffiticode, that means specialized agents can accept work and use a common execution platform to complete it. The specialist's value includes its tools, authorization, language expertise, operational reliability, and responsibility for the outcome.

A2A provides an interface for collaboration and delegation across agent boundaries. MCP provides an interface for tools and resources. The two can coexist in the same product. [1]

## 3. MCP and A2A in the Graffiticode model

Graffiticode's MCP tools already accept natural-language intent. Adding A2A therefore does not introduce natural-language input for the first time.

| Dimension | MCP interface | A2A interface |
| --- | --- | --- |
| Client-facing unit | A named tool with a documented input and output contract | An agent service with declared skills and interaction capabilities |
| Typical interaction | Invoke a capability exposed by the server | Delegate work to a specialized service and exchange messages or results |
| Discovery | Discover the server's tools and related capabilities | Obtain an Agent Card and identify relevant skills |
| Graffiticode implementation | Vendor translates tool input into programs and orchestrates backend execution | Vendor translates delegated intent into programs and orchestrates backend execution |
| Shared foundation | The same languages, policy controls, execution services, and artifacts can support both | The same languages, policy controls, execution services, and artifacts can support both |

Neither external writes nor autonomous work is exclusive to A2A. Long-running work can also be supported through MCP mechanisms, subject to the versions and capabilities implemented by the client and server. The MCP Tasks extension is one documented mechanism. [2]

The useful distinction is the service contract presented to the client. A natural-language MCP tool can perform sophisticated work internally; an A2A service can expose the same underlying expertise through an agent-oriented interaction.

Authorization must be enforced by the execution infrastructure regardless of protocol. A description in a tool schema or Agent Card communicates scope but does not enforce it.

## 4. Initial Learnosity service boundaries

### Two logical A2A services

The initial recommendation was to expose:

1. **Learnosity Assessment Authoring:** creating and revising assessment content, previewing it, and saving to authorized destinations.
2. **Learnosity Data Operations:** appropriately scoped data access, migration, batch processing, and analytics workflows.

Each service would have its own Agent Card, skills, examples, and authorization requirements. “Data Operations” is a clearer customer-facing description than simply “Data API.”

These are product and responsibility boundaries. They do not require separate Graffiticode backends, separate deployed processes, or a one-to-one mapping between agents and languages. A specialized agent may use several languages; several agents may use a common language.

### One MCP server with bounded toolsets

For the initial Artcompiler Learnosity integration, the recommendation was one MCP server with separate assessment-authoring and data-operations toolsets.

Each tool should communicate the work it can perform, including possible writes or other effects. Actual access remains subject to backend authorization.

Separate servers become justified when customer audiences, authentication, deployment schedules, operational ownership, or service requirements diverge enough to warrant them. Two logical A2A services do not automatically require two MCP servers.

## 5. Front-end and backend responsibilities

“Front end” includes the vendor's application servers and agent services, as well as browser interfaces.

| Layer | Responsibilities |
| --- | --- |
| Vendor front end, such as an Artcompiler deployment of graffiticode-app | User experience, natural-language intent, model selection, prompts, oracle use, generation, repair, workflow orchestration, MCP/A2A interfaces, customer packaging, and retail pricing |
| Graffiticode backend | Language execution, authentication and authorization infrastructure, policy enforcement, brokered credentials, egress controls, execution state, artifact storage, and operational observability |
| Language implementation | Language-specific syntax, semantics, validation, compilation, and interpreter behavior within platform controls |
| Language author and maintainers | Maintaining the implementation, declaring its capabilities accurately, and addressing language-specific defects |
| External service | Its own records, API behavior, credentials, and service-specific permissions |

**All code generation belongs to the front end**, including generation for community languages. The backend's generality comes from executing many languages under common controls.

Tenant, application, customer, and actor context should survive the handoff into execution. The party paying for usage may differ from the owner of the data or the person authorizing an action.

### Graffiticode terminology

- **Task:** `(lang, code)`.
- **Model:** `(lang, data)`.
- **Item:** a design-time repository of Task commits.
- **Form:** the language's runtime/interpreter.
- **Component:** the preferred user-facing term for the delivered result.

An **A2A task** is a protocol work unit. It should not be silently equated with a Graffiticode Task.

The discussion includes compilation and interpreter-based execution, including durable work. It does not establish a universal rule that every external effect must occur in only one stage.

## 6. Branding, domains, and repository boundaries

The discussion began with the concern that `console.graffiticode.org` exposed Graffiticode branding inside an Artcompiler product.

The proposed arrangement is:

| Interface or service | Proposed domain treatment |
| --- | --- |
| Artcompiler console | `console.artcompiler.com` |
| Other Artcompiler applications and agent interfaces | Appropriate hosts under `*.artcompiler.com` |
| Shared Graffiticode services | Appropriate hosts under `*.graffiticode.org` |
| Other vendors' products | Their own product domains |

Repository packaging does not determine public branding. The presence of `api`, `auth`, `policy`, `broker`, `egress`, and language services in the Graffiticode monorepo does not require duplicating them under every vendor's domain. Internal services need only the exposure their operation requires.

The shared-cloud proposal superseded the earlier idea that Artcompiler would necessarily need its own complete backend deployment to preserve the product abstraction. Independent hosting remains available when a vendor needs it.

## 7. Agent discovery, cards, and client targets

### Discovery

A2A Agent Cards describe an agent's identity, skills, interfaces, and interaction requirements. Clients can obtain them through configured locations, a known domain's well-known URL, or a registry/catalog. The protocol does not require a single universal agent directory. [3]

Publishing a card at a well-known path helps a client that already knows the domain. Reaching new clients also requires distribution through documentation, integrations, catalogs, or other discovery channels.

### Proposed Artcompiler Agent Card URLs

- [Assessment Authoring Agent Card](https://learnosity-assessments.artcompiler.com/.well-known/agent-card.json)
- [Data Operations Agent Card](https://learnosity-data.artcompiler.com/.well-known/agent-card.json)

The proposed invocation endpoint is `/a2a` on each host. That path is an application choice; clients should use the endpoint and transport declared in the card. These addresses are proposals, not deployment claims.

### Candidate clients discussed

The discussion considered Google ADK and A2A development/test clients, Microsoft Copilot Studio, Google Gemini Enterprise, IBM's enterprise agent ecosystem, and OpenClaw.

These are candidate integration targets, not committed integrations. Client selection should consider actual customer demand alongside protocol version, transport, authentication, task handling, and result presentation. A successful development-client test does not establish compatibility with every enterprise client.

OpenClaw's documentation describes a bundled A2A channel plugin, inbound Agent Card discovery, and outbound messaging to configured peers. Outbound messages go directly to configured peer endpoints without Agent Card discovery. Support should be evaluated against the specific version and workflow being targeted; complete remote-job lifecycle behavior should not be assumed from the existence of A2A support. [4]

## 8. Open-source language hosting and vendor differentiation

The hosting policy proposed by the user is:

> To have a language hosted on gc.org, its implementation must be open source.

Vendors can submit languages for inclusion and reuse community languages. Vendors that require closed language implementations can operate their own infrastructure.

This policy applies to hosted language implementations. It does not require a vendor's front end, model prompts, generator, or business workflows to be public. It also does not make customer programs, data, or credentials public.

The intended benefits include inspectability, shared maintenance, easier continuity, and a broader language ecosystem. Source availability supports review; inclusion still requires appropriate licensing, maintenance, and operational review.

Front ends differentiate through quality of service in a broad sense:

- Understanding user intent and producing correct programs.
- Domain expertise and useful workflows.
- Validation, recovery, and presentation of results.
- Product experience, support, and price.
- Performance and availability commitments supported by the infrastructure they use.

The shared service gives those businesses a common foundation. A vendor's claims about latency or uptime must remain consistent with its backend arrangements.

## 9. Usage pricing and permanent preservation

### Pricing direction

Usage-based pricing was the preferred direction. The user identified compile-payload size and interpreter compute as plausible units.

The recommendation developed into four potential charges:

1. **Creation and preservation:** an intake charge and an upfront contribution for newly retained content.
2. **Execution:** compiler and interpreter resources actually consumed.
3. **Substantial access:** retrieval, reactivation, or delivery charges where the underlying costs justify them.
4. **Optional service commitments:** capacity, support, or performance arrangements.

Prepaid credits and a subscription minimum credited against usage were discussed as possible billing arrangements. No rates or final packaging were selected.

For the shared service, a practical default is wholesale billing to the front-end vendor, with usage attributable to its customers. The vendor separately prices generation and its product.

### What should count

Incoming source size alone may understate storage obligations. Pricing should consider newly retained source, Models, assets, saved results, and retained execution history.

Idempotent retries and retrieval of existing artifacts should not repeatedly incur a new preservation charge. The exact treatment of logical bytes, deduplication, metadata overhead, and billing-account boundaries remains a design decision.

Compute charging should reflect resources consumed. A durable workflow suspended while waiting should not automatically be charged as if it were actively computing for its entire elapsed lifetime.

### Permanent retention and access speed

The user clarified that permanent storage does not imply permanently fast access. Older tasks can move into colder storage while retaining stable identifiers and enough metadata to locate and recover them.

Retrieval speed, reactivation behavior, and cost should be explicit service properties. Cold storage does not inherently require slow retrieval; the behavior depends on the storage class and provider. [5]

The preservation model must cover redundancy, integrity checks, indexes, migration, and recovery as well as raw bytes. No permanent-storage price, funding horizon, or contractual guarantee was finalized.

## 10. Proposed nonprofit foundation and preservation fund

The user proposed a nonprofit foundation that could adjust prices to keep excess surplus low and maintain a trust for future storage costs.

The recommended financial objective is:

> Provide execution at sustainable cost, fully fund long-term preservation, and pass efficiency gains back to users through lower prices.

Three funding purposes should be distinguished:

| Funding purpose | What it supports |
| --- | --- |
| Current operations | Execution, maintenance, security, support, and administration |
| Operating reserve | Resilience to unexpected costs and interruptions in revenue |
| Preservation fund | The future cost of retaining and recovering artifacts already accepted |

A preservation contribution should be allocated when an artifact is accepted. Future storage obligations should not depend on whatever happens to remain after annual expenses.

A useful planning test is whether the existing archive could remain supported if new artifact creation stopped. Annual pricing reviews should consider costs, reserve adequacy, and preservation funding before reducing rates.

### Reserve, trust, and tax status

The institution and fund structures remain proposals.

A nonprofit corporation does not automatically receive federal tax exemption. Any exemption strategy must fit the organization's actual purposes and activities. [6]

An internal board-designated reserve is generally reversible by the board. Customer fees earmarked for preservation do not automatically become donor-restricted endowment assets. A trust or other restricted arrangement would need legal documents that define permitted uses, oversight, withdrawals, and succession. [7]

If pursuing 501(c)(3) status, the foundation would need to meet the applicable exempt-purpose and private-benefit requirements. Artcompiler's role as a customer, contributor, or supplier should be governed by transparent and appropriately independent decisions. [8]

The preservation program should also define how custody can pass to a successor. Funding alone is insufficient without usable archives, manifests, ownership and access records, and recovery procedures.

## 11. Shared security as a core purpose

The user's strongest rationale for shared hosting is consolidating difficult security work into a well-funded open-source community.

The proposed model combines:

- **Inspectable implementations:** community and independent review of the platform and hosted languages.
- **Shared operation:** centrally maintained services and managed deployment of fixes.
- **Accountable staffing:** funded maintainers and operators responsible for reviews, updates, monitoring, and incident response.

The community contributes knowledge and scrutiny; the foundation accepts responsibility for operating the service. OpenSSF's guidance supports explicit vulnerability-reporting processes and identified response teams. [9]

The governing execution principle is:

> Generated code requests capabilities; the platform determines whether those capabilities may be exercised.

### Responsibility boundaries

**The foundation/operator** should own platform isolation, enforcement of grants, protection of stored data and brokered credentials, execution infrastructure, and platform incident response.

**Language maintainers** should own the correctness and maintenance of their implementations within the platform's controls.

**Front-end vendors** should own their application security, customer-facing permissions, information sent to generation models, and whether requested operations correctly represent user intent.

A platform may enforce every permission correctly while a front end requests the wrong permitted action. Shared infrastructure therefore makes vendor responsibilities narrower and clearer without eliminating them. This is consistent with the broader cloud model of shared security responsibilities. [10]

Consolidated hosting also concentrates the impact of shared defects. Isolation, controlled releases, and independent review are therefore part of the service the foundation must fund.

Security should be a core operating expense. Preservation funding should include the ongoing work required to keep archived artifacts secure, intact, and recoverable.

## 12. Open decisions and implementation priorities

The conversation established direction rather than a completed implementation. The principal decisions still to make are:

1. **Service contracts:** precise Learnosity agent and tool scopes, results, permissions, and completion behavior.
2. **Protocol interoperability:** supported A2A/MCP versions, transports, authentication, discovery, and client-specific behavior.
3. **Vendor integration:** identity propagation, tenant context, grants, payer attribution, and access to shared artifacts.
4. **Language admission:** licensing requirements, review, version support, maintenance expectations, and removal or deprecation procedures.
5. **Pricing units:** retained-byte accounting, per-artifact overhead, compute metering, included access, and wholesale billing.
6. **Preservation contract:** what is retained, retrieval expectations, explicit deletion and access rules, and successor custody.
7. **Institutional structure:** foundation governance, tax treatment, operating reserves, and the legal form of preservation funding.
8. **Security operations:** accountable ownership, staffing, review processes, incident response, and sustained funding.

The recommended sequence is to define these contracts and responsibility boundaries, implement a focused Learnosity offering using the shared backend, and validate both protocol integration and unit economics before extending the service broadly.

## References

The product and institutional choices above summarize this conversation. These primary sources support the protocol, storage, nonprofit, and security distinctions; they do not establish that the proposed Graffiticode arrangements have been implemented.

1. [A2A: A2A and MCP](https://a2a-protocol.org/latest/topics/a2a-and-mcp/)
2. [MCP Tasks extension](https://tasks.extensions.modelcontextprotocol.io/) and [MCP tools specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/tools.mdx)
3. [A2A: Agent discovery](https://a2a-protocol.org/latest/topics/agent-discovery/) and [Agent Card specification](https://a2a-protocol.org/latest/specification/agent-card/)
4. [OpenClaw: A2A channel](https://docs.openclaw.ai/channels/a2a)
5. [Google Cloud Storage: Storage classes](https://docs.cloud.google.com/storage/docs/storage-classes)
6. [IRS: Federal tax obligations of nonprofit corporations](https://www.irs.gov/charities-non-profits/federal-tax-obligations-of-nonprofit-corporations)
7. [IRS: Instructions for Schedule D, Form 990 — endowment distinctions](https://www.irs.gov/instructions/i990sd)
8. [IRS: 501(c)(3) exemption requirements](https://www.irs.gov/charities-non-profits/charitable-organizations/exemption-requirements-501c3-organizations) and [private-benefit restrictions](https://www.irs.gov/charities-non-profits/charitable-organizations/inurement-private-benefit-charitable-organizations)
9. [OpenSSF: Coordinated vulnerability disclosure guide](https://oss-vulnerability-guide.openssf.org/maintainer-guide.html)
10. [Google Cloud: Shared responsibilities and shared fate](https://docs.cloud.google.com/architecture/framework/security/shared-responsibility-shared-fate)

