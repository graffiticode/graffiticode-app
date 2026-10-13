# Graffiticode delegated API permissions — design state

> **Status:** design recorded 2026-09-25; execution contracts revised 2026-09-26.
> The owner-only baseline is implemented on branches and tested, but **not
> deployed**; the revised contracts and delegation to other accounts are
> not built. It supersedes the earlier informal effect-scan and generic grant
> model in this document. How the build maps onto this design, and every
> branch, is in `capability-policy-as-built.md`.

## Goal and terminology

An owner of an external API connection can let another Graffiticode account
invoke specific compiler functions through that connection without disclosing
the external API key. Only compiler functions that call external APIs require
permission. Ordinary compiler functions remain unrestricted.

This is owner-managed **delegated authorization with scoped execution tokens**.
The stored grant is a relationship between identities, a connection, and a
function; the token proves authorization for a particular execution. We use
"capability" informally for the protected function, rather than claiming the
whole system is a strict object-capability model.

## Grant and management model

- A grant identifies the credential owner's UID, recipient UID, credential
  connection ID, language ID, and stable protected function name. The function
  name is the permission key. The model treats preview and write as distinct
  compiler functions; each API-calling function has its own permission key.
- The credential owner creates, lists, and revokes grants in a policy editor in
  Console Settings or an adjacent page. The owner can grant to another account
  by UID. Recipients can see connections granted to them and explicitly select
  a connection for a compile. They cannot pass a grant on to someone else.
- Grants attach to a connection, rather than to the current value of its API
  key, so rotating the key need not change the grants. A connection's owner
  and backend are immutable, and deleted connection IDs are never reused.
  Transferring ownership or changing the provider account requires a new
  connection ID and new grants; rotation only replaces credentials for the
  same provider account.
- A central policy authority owns the grant store and decisions. Auth remains
  responsible for identity; the API gateway remains responsible for task
  storage and compiler routing. The compiler cannot create or broaden grants.

## Protected compile and call

1. The recipient starts a compile with a selected connection. Auth establishes
   the recipient UID in trusted server context. The selected connection is
   caller input and must be checked against the grant; the program cannot
   supply or override the authorization context.
2. The compiler obtains the allowed protected function names for that UID,
   language, and connection once per compile. This set is a snapshot for that
   compile only; the next compile fetches policy again.
3. An admission pass checks every protected call before the transformer
   begins. An ungranted protected function is a compile error, so the
   transformer does not begin. Functions without external API calls need no
   permission check.
   - The pass scans every node of the parsed program, not the checker's walk,
     because the base checker does not visit every executable node.
   - Protected behaviour with no call in the source (e.g. L0176 signing every
     render) is declared by the language as an implicit protected function,
     required on every compile that selects a connection.
4. When the transformer reaches a granted protected function, the policy
   authority mints a short-lived token scoped to the recipient, connection,
   owner, language, registry version, function, intended broker call, operation
   ID, and a digest of that call's arguments. The admission pass supplies early
   rejection; the token supplies proof at the
   execution boundary.
5. A Graffiticode credential broker verifies the token against the actual
   requested operation, resolves the owner's credential, makes the external
   API call, and returns its result. The broker exposes named operations rather
   than an arbitrary HTTP proxy. The compiler and recipient do not receive the
   owner's external API key.

Running the program is the action. There is no separate save step or execution
mode: a granted protected call runs whenever its program runs, and the grant is
the authority. A retry continues the same logical invocation and reuses its
write receipts. Viewing an existing result does not run the program again.

The mapping from function to broker operations, backend and kind lives in one
reviewed, versioned **registry** that policy and the broker both consult. A
compiler (or a per-user language override) never defines the authority it
receives.

The broker is the security boundary that matters: a token checked only by a
compiler that already holds the owner's key would add little protection. A
managed secret store or integration provider may handle storage, rotation, or
OAuth connection management behind the broker; Graffiticode still owns the
function-specific grant and enforcement model.

## Why this design

- **Guard functions, not whole languages.** Most compiler functions are safe.
  The functions that call external APIs are known to the language implementation,
  so their names provide a direct permission vocabulary. This is clearer than
  inferring generic effects from an AST or treating every function in a service
  language as privileged.
- **Check before transformation.** The admission pass scans every node before
  the transformer starts. Rejecting an ungranted function there prevents the
  transformer from making earlier API calls before it discovers a later
  denial, against the compile's snapshot. A revocation during the compile can
  still stop a later call after earlier ones ran. The broker checks again at
  the call boundary, so correctness does not depend on the admission pass.
- **Keep policy central and cache only for one compile.** The connection owner
  needs to manage and revoke grants independently of the recipient's identity
  token. One policy fetch per compile avoids repeated lookups during AST
  traversal; a new compile sees policy changes without cross-request cache
  invalidation. The current compile intentionally uses one consistent snapshot.
- **Grant a connection, then select it explicitly.** An owner can delegate use
  without sharing an API key. Binding the grant to a connection survives key
  rotation. Explicit selection avoids guessing which owner's credential to use
  when a recipient has multiple grants for the same function.
- **Use a token across the broker boundary.** A direct policy lookup would be
  sufficient inside one trusted process. A scoped token lets the independent
  broker verify that this particular function call was authorized without
  trusting the compiler's assertion. Minting it near the call limits its useful
  lifetime; the admission pass's snapshot preserves early rejection.
- **Keep credentials and outbound calls in a Graffiticode broker.** A token adds
  little if the compiler can bypass it and use the owner's key directly. The
  broker holds that key and limits calls to named operations, while managed
  products may provide secret storage or OAuth lifecycle support. A generic
  authenticated HTTP proxy would expose more of the external API than a
  function-specific grant intends.

## Relationship to the current system

Today the Console can bind account credentials into an AST at parse time, and
language compilers can use those credentials during compilation. Delegated
credentials must take a different path: the owner's secret cannot be embedded
in a recipient-owned task AST. Current authentication, task authorization, and
the language-composition `composesWith` allowlist do not implement the grants
described here. No policy authority, scoped execution token, or credential
broker is shipped by this design document.

## Decided

- **Tokens.** ES256 JWTs from policy, with a fixed algorithm, issuer, audience
  and token type per profile.
  - Session token: one compile's snapshot, about 15 minutes.
  - Execution token: one broker call, at most 60 seconds. It covers one
    request (its args digest) and the broker accepts it once.
- **Registry versions.** Session and execution tokens carry the registry
  version used at admission. Policy rejects a mint against a different version;
  the broker rejects execution unless that exact version is installed and
  enforced, including its operation payload constraints. A rolling deployment
  may retain an older reviewed version explicitly; it must never reinterpret
  an old token under the current registry. A mismatch is a refusal before any
  provider call, not a reason to silently start a new invocation.
- **Revocation.** Admission uses the compile's snapshot. Every mint re-reads
  the live state, so revoking a grant, or disabling or deleting a connection,
  stops the next mint in a compile already running. A token already issued
  lives at most 60 seconds and can authorize only its original connection and
  owner. Reownership is prohibited; a transfer creates a new connection.
- **Audit.** Every allowed and denied decision, and every connection change, is
  recorded with pseudonymous uids. Records never carry tokens, secrets or
  payloads.
- **Credentials.** The broker holds them, encrypted under a broker-only key and
  tied to their connection, immutable owner and backend. Before using a
  credential, the broker checks this binding against the execution token;
  lookup by connection ID alone is insufficient. Policy passes a credential
  through once, when a connection is created or rotated, and never stores it.
- **Migrating parse-time credentials.** The migration is enforced by
  invalidating old credentials at the provider, including Graffiticode's own
  system credentials. Code changes only tidy up. New connection credentials
  never enter the parse-time ciphertext path.
- **Shared compile cache.** The gateway never serves or stores a result in the
  shared compile cache for a task chain that requires a protected function,
  whether or not a connection is selected. The private execution artifacts
  described below are separate from this cache and cannot bypass authorization.
- **L0176 saves.** `save-to-itembank <activity>` is the only item-bank write.
  The older member form is rewritten to it before admission, and any other way
  of setting the flag is refused.

## Invocation identity and write receipts

The authenticated entry point allocates and durably records a logical
invocation ID before dispatch. A request idempotency key is scoped to the
recipient and bound to the task-chain revision, selected connection and input
digest; reusing it for different input is refused. HTTP retries, job
redispatches and compiler retries reuse that invocation ID. An intentional
rerun receives a new ID, even for the same task. Neither a token ID nor the
content-addressed task ID alone identifies a logical invocation.

Each protected write has an operation ID derived from the invocation and a
stable call occurrence, including its composition stage and repeated-call
index. Policy binds that ID into the execution token. The broker atomically
claims a durable receipt before calling the provider, binding it to the
recipient, owner, connection, language, function, operation, registry version
and argument digest. A second token with the same ID and binding returns the
recorded outcome; a different binding is refused. Receipt replay requires
current authorization and a valid execution token, with no exception.

A pending receipt or a timeout after dispatch is an uncertain outcome, not
permission to execute again. Reconcile through provider status or provider
idempotency support where available; otherwise report uncertainty and require
an explicit decision to start a new invocation. That decision is the caller's:
it sends a new idempotency key (or none), knowing the write may run again, and
the error that reports the uncertainty says so. Record partial outcomes of
multi-step writes. Do not promise exactly-once provider execution. Receipt
retention must cover every accepted retry; after expiry, reject the old
invocation rather than treating a missing receipt as a new write.

### Recovering an invocation

The gateway, which receives the compile's output, stores the artifact in one
atomic write: the unsigned content and its selection as current happen
together or not at all. There is therefore no state in which content is
persisted but unpublished, and no separate artifact-only recovery or
replay-only token. (An earlier revision specified both, for a design in which
the compiler persisted content before a separate publication step.) The
gateway retries a failed artifact write within the request before giving up.

An invocation whose artifact was not stored — the compiler crashed after a
write succeeded, or the artifact write failed every attempt — is recovered by
**retrying the original invocation**: the caller repeats the request with the
same idempotency key. It is an ordinary compile under the original invocation
ID, so it keeps its operation IDs. It runs admission and needs current authorization, like any
compile. A call with a completed receipt returns the recorded outcome instead
of writing again. A call with no receipt executes normally. A call with a
pending or uncertain receipt blocks the retry until that receipt is
reconciled. If authorization has been revoked, the retry is refused, and its
completed writes stay recorded but unpublished; this is accepted rather than
bypassing a revoked grant.

A new invocation means an intentional rerun, never recovery. It gets new
operation IDs, so its writes run again.

## L0176 results and reads

Retain unsigned render content as a private execution artifact after a
successful invocation, separately from the shared compile cache. Bind it to
the recipient, owner, connection, task-chain revision, invocation and registry
version. It contains no credential or reusable authorization token. Its
identifier alone grants no access, and another account or connection cannot
reuse it as an authorized compile result.

Each view checks the task/artifact access rules and obtains fresh policy
authorization for the required preview-signing function through the selected
connection. The broker signs only the constrained preview request from the
artifact. A missing preview grant is a refusal; a write grant is not required
to view an existing artifact. Author signing remains a separate permission.
Views and learner-answer requests must not rerun the source program or its
saves. Any protected operation needed for an answer is authorized separately.

A missing or incompatible artifact requires an explicit program run; a read
must not silently rebuild it by executing writes. Artifact publication failure
after a provider write is recovered by retrying the original invocation (see
Recovering an invocation).

A view serves the artifact of the latest successful invocation for the
authenticated recipient, task-chain revision and connection. "Latest" is
invocation order, not completion time: invocation IDs carry a monotonic
sequence allocated at the entry point, and an artifact replaces the current one
only if its invocation is newer (compare-and-set). A slow older run cannot
replace a newer result.

## Published items

Publishing is the only way a protected artifact reaches another account.
Publishing records a publication that binds the publisher, connection,
task-chain revision and artifact. Creating one requires all of:

- The publisher is the artifact's recipient. A preview grant alone never lets
  anyone publish another recipient's private result.
- The publisher may publish the task under the task access rules.
- The artifact's connection and task-chain revision match the publication's.
- The publisher holds the preview grant on that connection. Under delegation,
  the grant must also permit publication, because published views spend the
  owner's credential on viewers the owner never named.

A view of a published item runs under the publication, not the viewer. The
viewer needs no grant and may be anonymous where the task's access rules
allow it. On each view, policy re-checks live state: the publication still
exists, the connection is enabled, and the publisher still holds the preview
grant, including, under delegation, permission to publish. Only then does it
authorize preview signing for that artifact.

A publication authorizes only functions the registry marks as view-safe,
which today means preview signing. Saves, Author signing and every other
protected function are refused, and a view never runs the program.
Unpublishing, revoking the publisher's grant, narrowing it to preview-only,
or disabling the connection stops further views. Any other cross-account sharing of a protected artifact
is outside this contract.

## Compiles without a connection

A compile that selects no connection has no protected authority. It never
contacts policy or the broker, allocates no invocation and writes no receipt.
Protected calls, explicit or implicit, are validated but not executed, and
L0176 renders unsigned. This is not an execution mode; it is the absence of a
grant. After parse-time credentials are invalidated, such a compile has no
credentials at all.

A skipped protected call is not an error. The compile succeeds, and its
result lists each skipped call separately from errors, with its function,
call occurrence and reason (`no-connection`). A program that is otherwise
valid passes verification. Real validation failures, such as an unknown
function or bad arguments to a protected call, remain compile errors. Skipped
calls are never fed to error correction as something to fix. This list
reports what did not run; unlike the removed "write not executed" marker, it
does not hide the preview.

Every automated compile runs this way. Code generation, its verification and
error-correction compiles, the corpus ping, eval and sweeps never select a
connection. Otherwise every draft revision would be a new invocation, and each
one would repeat the draft's writes.

## Release prerequisites

Removing Console-issued intent tokens, save/read write gating and the
"write not executed" marker depended on implementing the invocation/receipt
and artifact-read contracts above; they were removed on the branches once
those contracts were built. The checks below must still pass against a
deployed system before release. Deployment also requires broker credential
binding, registry-version enforcement and compiler egress control: compilers
must be unable to reach provider hosts directly, so no call can bypass the
broker. Without that, the broker is not the boundary. These are design
requirements, not claims about the current branches.

Before release, verify that concurrent retries and redispatched
jobs execute each write at most once through the broker; timeouts remain
uncertain; intentional reruns have new identities; and views/answers never
repeat saves. Verify cross-account/connection artifact denial, current preview
authorization, expired-invocation rejection, transfer isolation and registry
version mismatch rejection before provider calls. Also verify:

- retrying an invocation after a crash that followed a completed write keeps
  the invocation ID, returns the recorded outcome instead of writing again,
  stores the artifact, and blocks on a pending or uncertain receipt; after
  revocation the retry is refused without contacting the provider
- an uncertain write reports that a new idempotency key starts a new
  invocation whose write may run again, and that rerun does write
- a view selects only the recipient's own artifact, and an older invocation
  cannot replace a newer artifact
- publication is refused for another recipient's artifact or a mismatched
  connection or revision; published views stop once the publisher's grant is
  revoked or narrowed to preview-only, and can never save
- generation and ping compiles make no broker calls, and a program whose only
  issue is a skipped save passes verification without triggering correction
- a compiler cannot reach a provider host directly

## Open design work

- **Author signing.** It carries edit and delete authority. It stays
  non-delegable, and its request shape is unchecked against Learnosity's
  Author API.
