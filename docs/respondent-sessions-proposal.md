# Respondent sessions: a console proposal

**Status:** proposal, docs only (2026-11-25). Nothing here is implemented or approved for implementation. It changes no stored item, task or session, and historical sessions are never rewritten.

**Why now.** C4 in the backend (`graffiticode` `docs/c4-l0182-assignment-plan.md`) gives each L0182 respondent a durable survey assignment keyed by `(survey, session)`, where the session is the console item id folded into the program. The slice 0 inventory (`graffiticode` `docs/evidence/interpreter-c4-l0182/slice0-inventory.md`) showed that a copied literal session is **not** reliable evidence of who the respondent is or who owns the response: copies carry their source's session. The owner's direction (2026-11-25):
- a new respondent's copy gets a fresh session;
- revisions keep the session;
- continuing the same response under another owner keeps it, through explicit ownership rebinding.

This document proposes how the console does that. The backend's identity and migration decisions stay open and are not decided here.

## 1. Where we start

**How a session gets into a program.**
- An L0182 program writes `session-id get-val-public "itemId"`. The console resolves `itemId` when it parses (`packages/console/src/pages/api/index.ts:532`, `packages/core/src/lib/code-generation/generate-for-request.ts:523`).
- The parser **folds** it into a plain string literal (`graffiticode` `packages/parser/src/folder.js:72`).
- The item stores only that folded AST (`code`), with no source. From then on nothing records which literal came from `itemId`.

**The paths that create or change an L0182 item's program:**

| Path | What it does to the session today | Where |
|---|---|---|
| Console chat generation | folds the item's **own** id | `generate-for-request.ts:523` |
| MCP `create_item` / `update_item` | reserves or reuses the item, and folds **its own** id | `packages/core/src/generation.ts` (`reserveGeneration`) |
| Editing in the console | keeps the program's existing literal | the editor re-posts the AST |
| Console **Copy** menu | a new item with the **same task**, so the same session and assignment | `packages/console/src/components/ItemsNav.tsx:128` (`createItem({ taskId })`) |
| **Share** with another user | the recipient gets a new item id with the program copied, so the **sender's** session | `packages/core/src/items.ts:901` (`shareItem`), then a lazy re-post of the same code (`items.ts:~808`) |
| Free-plan **claim** | the claimer gets a new item id with the program copied, so the **free-plan item's** session | `packages/core/src/claims.ts` (`claimFreePlanSession`) |
| Eval item creation | folds the corpus example's **fixed** id, reused on every run, under whichever account runs it | `packages/console/scripts/create-items-from-prompts.ts:437` |

Tasks are content-addressed, so a verbatim copy maps to the same task, and therefore to one stored compile and one assignment shared between source and copy.

## 2. Definitions

- **Respondent session:** the value that identifies one response for the backend. It is the id of the item where the response was started, folded into the program.
- **A new respondent:** someone starting their own response, or the same person starting another one. Copying an item to take the survey, sharing a survey for someone else to take, and each eval run are all new respondents.
- **The same response, continuing:**
  - a revision of the item (edit, regenerate, `update_item`);
  - moving the response to another owner who carries it on: a free-plan claim by the same person, or a future explicit transfer.
- **Respondent-bound language:** a language whose program carries a respondent session. Only L0182 is one today. Every other language is unaffected by this proposal.

## 3. Rules

1. **A new respondent gets a fresh session:** the new item's own id, folded as at generation. Never the source's.
2. **Revisions keep the session.** Editing, regenerating and `update_item` on the same item keep its session. This is already true, since the item id doesn't change.
3. **Continuing the same response under another owner keeps the session, and rebinds ownership explicitly.** The program, answers included, is kept unchanged, so the backend assignment and any frozen answers carry over. A **rebinding record** says who owns that session from now on (§4.3). Nothing infers ownership from the copied literal.
4. **Answered copies.** A response belongs to its respondent, so:
   - a copy for a **new respondent** starts **unanswered**. It keeps the survey (`id`) and nothing of the source's `response`;
   - showing someone an answered response is **viewing**, not copying. Use the item's read-only view or link, which keeps the original session and owner, and freezes nothing for the viewer (the backend's submission check admits only the session's owner);
   - **continuing** an answered response under another owner is rule 3, and only through an explicit action (claim, transfer), never through Copy or Share.
5. **History is not rewritten.** Existing items, tasks and sessions stay exactly as they are. The rules apply to copies made after they ship. A copy of a historical item follows rules 1 and 4: it gets a fresh session and starts unanswered. Its source is untouched.

## 4. Mechanism

### 4.1 Knowing which literal is the session (provenance)

The console can't safely rewrite a folded literal after the fact: a string equal to the item id could also be something the author wrote. Two options for the owner:
- **(a) Keep the source form for respondent-bound languages** *(proposed)*. For a respondent-bound language, a fresh copy is **re-generated** from the language's unanswered form, parsed with the new item's id (§4.2). The console never edits a folded AST, so it needs no provenance.
- **(b) Record provenance at parse time.** `parseCode` records the AST positions where `itemId` was folded (`publicBindings: { itemId: [paths] }`) on the item, and a fresh copy re-folds exactly those. It is general, but needs a parser or console change and covers only items parsed after it ships. Historical items have no record, so they would still need (a).

### 4.2 A fresh, unanswered copy

- The console's language catalog (`packages/core/src/lib/languages.ts`) gains a declaration for respondent-bound languages: `respondent: { binding: "itemId", freshCopy: "survey-id" }`. Only L0182 declares it.
- For L0182, a fresh copy reads the source program's survey `id` (a literal in every working production program, per the inventory). It then parses `survey [id "<id>" session-id get-val-public "itemId"]..` with `publicValues: { itemId: <new item id> }`. That is the unanswered form of the language's own `template.gc`.
- If the source's `id` isn't a literal string (no working production program has this), the copy is refused with a message, rather than guessed.
- The result is a new task, so a new stored compile, and in the backend a new assignment drawn for the new session.

### 4.3 Explicit ownership rebinding

- **The record** is server-only, written by the console in the same transaction as the action that continues the response:

  `respondent-bindings/<session>` = `{ ownerUid, itemId, via: "claim" | "transfer", from: { uid, itemId }, at, by }`

  One record per session, overwritten only by a later explicit rebinding of the same session. Each write is appended to `respondent-bindings/<session>/history`.
- **The consumer** is the backend's item authority. The console's internal route (`packages/console/src/pages/api/internal/item-authority.ts`) answers for an item id. For a session that has a rebinding record, it answers with the record's `ownerUid` instead of the owner of the item whose id the session happens to be. That route is what Policy asks (C5a decision 3) and what C4's submission check will consult. No other consumer needs to change.
- **Who may rebind:** only the action's own server code (the claim flow, a future transfer route), for a caller who owns the source. Never an agent tool or a program.

### 4.4 Path by path, after the change

| Path | Respondent-bound (L0182) | Other languages |
|---|---|---|
| Console chat generation, MCP create/update | unchanged (own id) | unchanged |
| Editing, regenerating | unchanged: the session is kept (rule 2) | unchanged |
| Console **Copy** | fresh, unanswered copy (4.2) | unchanged (same task) |
| **Share** | the recipient gets a fresh, unanswered copy; a "share for viewing" link shows the answered original instead | unchanged |
| Free-plan **claim** | the program is kept, answers included, plus a rebinding record (`via: "claim"`) | unchanged |
| **Transfer** (future) | the same as claim (`via: "transfer"`) | not applicable |
| **Eval runs** | each run creates its own item and folds its own id, never the corpus example's fixed id | unchanged |
| MCP `create_item` from another item's `get_spec` | a new respondent; the spec must not carry the source's response (open question 3) | unchanged |

## 5. Acceptance tests (when implemented)

- Copy, share and an eval run of an L0182 item each produce a new item whose program's `session-id` is the new item's id, with no `response`, and a different task from the source.
- Copying an **answered** item yields an unanswered copy. The source's response, task and session are unchanged.
- A revision keeps the session byte for byte.
- A claim keeps the program and answers, and writes exactly one rebinding record (plus history). Item authority for that session then answers with the claimer.
- A rebinding can't be written from MCP, REST or a program, or for a source the caller doesn't own.
- Copying a non-respondent-bound item behaves exactly as today (same task).
- No existing item, task or session changes when this ships.

## 6. Rollout

Console only, behind a flag per path (Copy, Share, claim rebinding, eval script), each shipped and verified on its own. No backfill, and no rewriting of history. The backend's C4 work reads rebinding records only once its own decisions are made. Until then the records are inert.

## 7. Open questions for the owner

1. **Provenance:** source-form regeneration only (4.1 a), or also parse-time provenance (4.1 b)?
2. **Copy menu wording:** should **Copy** on an answered L0182 item offer an explicit "continue this response" (a transfer to yourself, which is pointless within one account) or only "start a new response"? Proposed: only "start a new response". Continuing is claim or transfer.
3. **`get_spec` for an answered L0182 item:** should it describe the survey only (proposed), or also the answers, for uses that aren't new responses?
4. **Free-plan items after a claim:** the source item under the trial account stays until it expires. Should the claim also mark it read-only so it can't be answered further under the old owner?
5. **Eval reproducibility:** per-run item ids make every eval run a new respondent. Is that the intent, or should some eval suites deliberately reuse one session to test assignment stability?
