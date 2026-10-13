---
name: item-version-history
description: Item version history under users/{uid}/versions — recordVersion() call sites, pointer-only create-if-absent writes, the clamped source field, the taskVersions query behind /tasks, and the backfill script. Read before touching recordVersion, taskVersions, the /tasks list, or anything that records or reads an item's content states.
---

# Item version history (`users/{uid}/versions`)

Every content state of an item is recorded as a flat, append-only doc `{itemId}__{taskId}` — `recordVersion()` in `src/pages/api/resolvers.ts`, called from `createItem`, from `updateItem`'s `taskIdChanged` branch (the one signal every producer funnels through: chat, **direct editor edits**, the generation worker, MCP), and from the lazy-repost branches in `getItems`/`getItem` (where a shared/claimed item's v1 is born — the copy sites leave `taskId: null` and the original task isn't in the new uid's ACL).

Records are **pointer-only**: taskIds are content-addressed and permanently stored by api.graffiticode.org, so code is never duplicated.

Writes are create-if-absent, NOT set/merge — reverting re-derives the same taskId, and merging would overwrite that version's original `createdAt`/`source`; a revisit records `lastSeenAt` instead.

`source` (`chat`/`editor`/`mcp`/`generation-job`/`claim`/`share`/`backfill`) is caller-supplied but clamped server-side. History does **not** cross accounts: share/claim start at v1.

Read via the `taskVersions` query (lang/client/itemId filters, `createdAt desc`), which backs the `/tasks` list — a flat newest-first row per version, replacing the `compiles` feed that went silent on 2026-06-09 when Cloudflare edge-caching of `/data` stopped the api's origin callback from firing.

Seed pre-existing history with `npx tsx scripts/backfill-item-versions.ts [--lang 0166] [--dry-run]` (idempotent; recovers taskIds from `help` transcripts, which never captured direct editor edits).
