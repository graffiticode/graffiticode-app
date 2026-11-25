# Respondent sessions: a console proposal

**Status:** proposal, docs only, revised after the owner's first review (2026-11-25). Nothing here is implemented or approved for implementation. It changes no stored item, task or session, and historical sessions are never rewritten.

**Why now.** C4 in the backend (`graffiticode` `docs/c4-l0182-assignment-plan.md`) gives each L0182 respondent a durable survey assignment keyed by `(survey, session)`, where the session is the console item id folded into the program. On submission, C4 freezes the **assignment and the survey model** the answers were given against. It does not freeze the answer text, which stays in the program. The slice 0 inventory (`graffiticode` `docs/evidence/interpreter-c4-l0182/slice0-inventory.md`) showed that a copied literal session is **not** reliable evidence of who the respondent is or who owns the response: copies carry their source's session. The owner's direction (2026-11-25):
- a new respondent's copy gets a fresh session;
- revisions keep the session;
- continuing the same response under another owner keeps it, through explicit ownership rebinding.

This document proposes how the console does that. The backend's identity and migration decisions stay open and are not decided here.

**What the first review changed:**
1. Respondent authority is a separate lookup that C4 consumes. Item ownership, and C5 capture authority, are unchanged (§4.3).
2. A rebinding must prove authority over the **session**, not just the item: a verified current binding, claim-workspace proof, and an atomic check of the binding's revision, with retry, replay and concurrent claims defined (§4.4).
3. A server-owned session value is used by every generation and parse of an item, so a claimed item keeps its session through regenerations and MCP updates (§4.2).
4. Fresh copies accept only a validated single-survey form and refuse anything else. They keep named-version references exactly, and carry no answer-bearing transcript or cached recipe (§4.1).
5. The open choices are decided by the owner (§7).

## 1. Where we start

**How a session gets into a program.**
- An L0182 program writes `session-id get-val-public "itemId"`. The console resolves `itemId` when it parses (`packages/console/src/pages/api/index.ts:532`, `packages/core/src/lib/code-generation/generate-for-request.ts:523`).
- The parser **folds** it into a plain string literal (`graffiticode` `packages/parser/src/folder.js:72`).
- The item stores only that folded AST (`code`), with no source. From then on nothing records which literal came from `itemId`.
- **Generation always folds the item's own id.** A claimed item, whose program carries the free-plan item's session, would therefore get its own id folded in at its next regeneration, and silently become another respondent.

**What an item document carries besides its program:**
- `help`, the chat transcript, which can contain the answers as prompts;
- `spec`, the cached `get_spec` recipe, stored on the item document (`packages/core/src/spec.ts`).

Share and claim copy the item document.

**The paths that create or change an L0182 item's program:**

| Path | What it does to the session today | Where |
|---|---|---|
| Console chat generation | folds the item's **own** id | `generate-for-request.ts:523` |
| MCP `create_item` / `update_item` | reserves or reuses the item, and folds **its own** id | `packages/core/src/generation.ts` (`reserveGeneration`) |
| Editing in the console | keeps the program's existing literal | the editor re-posts the AST |
| Console **Copy** menu | a new item with the **same task**, so the same session and assignment, and the source's `help` | `packages/console/src/components/ItemsNav.tsx:128` (`createItem({ taskId, help })`) |
| **Share** with another user | the recipient gets a new item id, with the program and document copied, so the **sender's** session | `packages/core/src/items.ts:901` (`shareItem`), then a lazy re-post of the same code |
| Free-plan **claim** | the claimer gets a new item id, with the program and document copied, so the **free-plan item's** session | `packages/core/src/claims.ts` (`claimFreePlanSession`) |
| Eval item creation | folds the corpus example's **fixed** id, reused on every run | `packages/console/scripts/create-items-from-prompts.ts:437` |

Tasks are content-addressed, so a verbatim copy maps to the same task, and therefore to one stored compile and one assignment shared between source and copy.

## 2. Definitions

- **Respondent session:** the value that identifies one response for the backend, folded into the program.
- **The item's session:** the session an item's programs carry. Server-owned and stored on the item (§4.2). For an item that started its own response it equals the item's id; for a claimed or transferred item it is the session it continued.
- **A new respondent:** someone starting their own response, or the same person starting another. Copy, Share and an ordinary eval run are new respondents.
- **The same response, continuing:**
  - a revision (edit, regenerate, `update_item`);
  - a free-plan claim, or a future explicit transfer.
- **Respondent-bound language:** a language whose program carries a respondent session. Only L0182 is one today. Every other language is unaffected.

## 3. Rules

1. **A new respondent gets a fresh session**, the new item's own id, and starts **unanswered** (rule 4).
2. **Revisions keep the item's session**, however they are made (§4.2).
3. **Continuing the same response under another owner keeps the session, and rebinds respondent authority explicitly** (§4.3, §4.4).
   - The program is kept unchanged, answers included, so C4's assignment, and any frozen assignment and survey model, carry over.
   - Nothing infers authority from the copied literal.
4. **Answered copies: "start a new response".**
   - A copy of an answered item for a new respondent keeps the survey and nothing of the source's response, transcript or recipe.
   - Showing an answered response is **viewing** (the read-only view or link), which keeps the original session and authority and freezes nothing.
   - Continuing an answered response under another owner is rule 3, through claim or transfer only.
5. **History is not rewritten.** Existing items, tasks and sessions stay as they are. The rules apply to copies, claims and revisions made after they ship. A copy of a historical item follows rules 1 and 4.

## 4. Mechanism

### 4.1 A fresh copy: canonical reconstruction, strictly validated

The console never edits a folded AST. A fresh copy is **reconstructed** from a canonical form, and only from a form it has validated.

- **Declaration:** the language catalog (`packages/core/src/lib/languages.ts`) marks respondent-bound languages, `respondent: { binding: "itemId", freshCopy: "single-survey" }`. Only L0182 declares it.
- **The supported form** (validated on the source program's AST before anything is built):
  - the program's value is exactly **one** `survey`, so a list of surveys, several top-level expressions and a survey inside any other construct are all refused;
  - its `id` is a string literal: a bare survey id (`civic-priorities`) or a named version (`civic-priorities-7`);
  - its `session-id` is a string literal, or absent;
  - it contains no variables, conditionals, functions or `use`;
  - its other attributes are only `response` and that response's words.
- **The reconstruction:** `survey [id "<id exactly as written>" session-id get-val-public "itemId"]..`, parsed with `publicValues: { itemId: <the new item's session> }`.
  - A named version stays named, byte for byte, and a bare id stays bare.
  - No response is carried.
- **Refused:** any program outside the supported form. The copy isn't made, and the message names the reason. Nothing is guessed. The slice 0 inventory found every working production program in this form. The conformance corpus has multi-survey programs, and those are refused.
- **What the new item carries:** a new task (so a new stored compile, and in the backend a new assignment), `help` empty (`"[]"`), no `spec`, no version history, and the item's session set to its own id.
- **Provenance** (recording where `itemId` was folded at parse time) can follow later. It would widen the supported form without changing these rules.

### 4.2 The item's session: server-owned, used by every generation and parse

- **The field:** each L0182 item gets `respondentSession`, written only by the console's server code:
  - set to the item's own id when the item is created;
  - set to the continued session S by a claim or transfer (§4.4);
  - never written by a client, an agent tool or a program.
- **Every fold uses it.** Every path that parses or generates for an item reads its `respondentSession` and passes it as `publicValues.itemId`, never the item's own id:
  - the console chat (`generate-for-request.ts`);
  - MCP `create_item`/`update_item` (`generation.ts`);
  - the editor's parse (`pages/api/index.ts`);
  - eval scripts.

  For items without the field (all items today), it reads as the item's own id, which is today's behavior.
- **Effect:** a claimed item T carrying session S keeps S in every program it produces, so revisions stay one respondent.
- **Test:** claim (S into T) → regenerate in the console chat → MCP `update_item` → each resulting program's `session-id` is S, and C4 sees one identity throughout.

### 4.3 Respondent authority, separate from item authority

- **Item authority is unchanged.** `POST /api/internal/item-authority { itemId }` keeps answering who owns an item and whether it is public. Policy's C5 capture checks keep using it exactly as today.
- **A new, response-specific lookup:** `POST /api/internal/respondent-authority { session }` answers one of:
  - `{ bound: true, ownerUid, itemId, revision, via }` from a binding record;
  - `{ bound: false, itemOwnerUid }` from the item whose id equals the session, when there is no binding: today's derivation, the default;
  - `{ unknown: true }`, when neither exists;
  - `{ ambiguous: true }`, when the item id is held under several users.

  The route's audience is the backend's identity that consumes it.
- **Only C4 consumes it**, for its submission check. C4's plan is to name this lookup explicitly when its identity decision is made. Nothing else reads respondent authority, and no existing behavior changes.
- **The binding record** is server-only:
  - `respondent-bindings/<session>` = `{ ownerUid, itemId, revision, via: "claim" | "transfer", from: { uid, itemId, revision }, at, by, opId }`;
  - every write is appended to `respondent-bindings/<session>/history`;
  - `revision` increases by one on each rebinding.

### 4.4 Rebinding: proving authority over the session

Owning an item doesn't establish ownership of the session embedded in it: a claim of an item carrying someone else's session would otherwise seize that response. A rebinding of session S therefore requires, all checked in **one transaction** with the binding and item writes:
1. **Current authority over S, verified:**
   - with a binding record, the caller (or, for a claim, the free-plan workspace being claimed) is its `ownerUid`;
   - without one, S equals the id of a source item in the workspace being claimed, held only there (no other holder anywhere, and not ambiguous);
   - a source item whose program carries a session that is **not** its own id (a historical copy) can't rebind S. It is claimed like any other item (the claimer gets it), but its response is not continued: it is treated as a new respondent (rules 1 and 4, a fresh unanswered reconstruction).
2. **Claim-workspace proof:** the claim token verifies, the workspace (`sessionNamespace`) matches, and the source item belongs to it, as today.
3. **The revision is unchanged:** the binding's `revision` (or its absence) equals what was read at the start, so the transaction fails if anyone rebound S meanwhile.

**Retry, replay and concurrency:**
- **Idempotent by operation.** Each claim or transfer carries an `opId` (the claim id). Replaying the same `opId` finds the binding it wrote (same `opId`, same target) and returns the same result with no second write.
- **Concurrent claims of one session:** both read revision n. One commits n+1; the other's transaction fails its revision check, re-reads, finds a binding it doesn't own, and is refused (`respondent-already-bound`), with no partial write.
- **A transaction that fails for a transient reason** is retried with the same `opId`. A refused rebinding leaves the item claim itself to proceed as a new respondent only if the caller chose that, never silently.
- **After a successful claim:** the source item under the trial account is marked **read-only**. It stays, with its history, until it expires, and can't be answered or regenerated further.

### 4.5 Path by path, after the change

| Path | Respondent-bound (L0182) | Other languages |
|---|---|---|
| Console chat generation, MCP create/update, editor | fold the item's `respondentSession` | unchanged |
| Copy | fresh reconstruction (4.1), or refused | unchanged |
| Share | recipient gets a fresh reconstruction; "share for viewing" shows the answered original | unchanged |
| Free-plan claim | rebinding (4.4); the program, answers and `respondentSession = S` kept; source read-only | unchanged |
| Transfer (future) | the same as claim | not applicable |
| Eval, ordinary runs | each run creates its own item, a fresh session | unchanged |
| Eval, stability tests | an explicit option reuses a named session, declared in the test | unchanged |
| MCP `create_item` from `get_spec` | a new respondent; `get_spec` is survey-only by default | unchanged |

## 5. Acceptance tests (when implemented)

- **Fresh copies:**
  - Copy, Share and an ordinary eval run of a supported L0182 item produce a new item with its own session, no `response`, empty `help`, no `spec`, and a different task;
  - a named version is preserved byte for byte;
  - a multi-survey or otherwise unsupported program is refused with a reason, and nothing is created.
- **Answered copy:** the result is unanswered; the source's response, task, session, transcript and recipe are unchanged.
- **Revisions:** stable session for an ordinary item, and for a claimed item: claim → console regenerate → MCP `update_item` keeps S.
- **Authority separation:** item authority and C5 capture decisions are byte-identical before and after. Respondent authority answers from the binding when one exists.
- **Rebinding:**
  - refused for a session the caller has no verified authority over, including a claimed item carrying another item's session;
  - concurrent claims of one session: exactly one wins and the other is refused;
  - a replayed `opId` is a no-op that returns the first result;
  - a revision change between read and write fails the transaction;
  - the source becomes read-only after the claim.
- **No path** (MCP, REST, a program) can write a binding or `respondentSession`.
- Non-respondent-bound languages behave exactly as today.
- No existing item, task or session changes when this ships.

## 6. Rollout

Console only, behind a flag per path (session field and folding, Copy, Share, claim rebinding, eval). Each ships and is verified on its own, and the session field and folding ship first. No backfill, and no rewriting of history. The respondent-authority lookup is inert until C4's identity decision adopts it.

## 7. Choices (decided by the owner, 2026-11-25)

1. **Fresh copies:** canonical reconstruction with strict validation initially; provenance can follow.
2. **Answered copies:** "start a new response".
3. **`get_spec`** for an answered L0182 item: survey-only by default.
4. **After a claim:** the source becomes read-only, keeping its history.
5. **Eval:** fresh sessions for ordinary runs; explicit session reuse for stability tests.
