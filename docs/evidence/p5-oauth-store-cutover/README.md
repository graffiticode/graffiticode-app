# Graffiticode OAuth-store handover

The production legacy store was fenced, imported and sealed on 2026-11-19.
The final [retirement report](retirement-report.json) allows retiring the
fallback. The accompanying configuration change selects local-only storage;
the final MCP release is a separate operator step after that change lands.

## Releases and prerequisites

- Backend auth: `auth-rmwnqn8lz-143390`, from backend commit
  `f8aaf3c1cff3dca9bf1a6b8d9a791db17aebcb2a`. Its deployed-instance contract
  verification is preserved in backend PR #435.
- MCP: `mcp-service-rmwnu4hvj-a067fb`, image
  `sha256:caa276b74aa0513a56db3746a4174eed7e94493b6747b096bf12eb99d8714365`.
- REST: `openapi-service-rmwnuxju4-0cb188`, image
  `sha256:edbd2a89b5573f298f48189967a0cc94f33bc52f9725b7be2a847345c9fb7e6d`.
- Both frontend releases were built cleanly from
  `8c5072a812a1ba49a2fbf6d51de7367c6d61b187`. Their candidate checks passed,
  they serve 100% of traffic, and their older revisions' tags were retired.
- All six generated TTL policies are `ACTIVE` in
  `graffiticode-app/(default)`.
- Before the fence, auth's `release-check` passed with no stale tags or
  revisions below `P5-fence`. The MCP/REST drain check passed against receipt
  `rmwnu4hvj-a067fb`, with only the two releases above reachable.

The first drain-check attempt stopped before querying revisions: it read the
deploy loader's context as if it were the resolved configuration. The fix
uses `context.config`, and its regression test exercises the real loader.
All nine deploy-tool tests passed before the live check was retried.

## Handover results (UTC)

- 18:12:53: the fence completed, including the source index repair.
- 18:17:02: import copied 428 clients and imported 107 tokens. No record was
  left prepared or tombstoned.
- 18:19:03: the sweep found no incomplete migrations or revocations to apply.
- 18:22:22: the source was sealed.
- 18:22:51: the final sweep found nothing outstanding.
- 18:24:21: the report showed 107 migrated tokens, no unmigrated tokens,
  missing clients, prepared records or unreconciled revocations,
  `sealed: true`, and `fallbackRetirable: true`.

A read-only OAuth lookup with a random nonexistent client also confirmed
that production MCP observed the fence and reported
`oauthStore: { mode: "migrating", migrating: true }`.

The local database is the Graffiticode installation's own
`graffiticode-app/(default)` database. Credentials stayed in memory during
operator calls; this evidence contains only targets, counts and release
identifiers. The backend installation boundary remains a separate phase.
