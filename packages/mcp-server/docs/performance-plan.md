# Performance Optimization Plan

Based on the v2.1.0 plugin submission (2026-09-20). Tool schemas and `_meta`
structure are frozen for this release.

## Current Architecture

### Request Flow

```
create_item POST ──► startCodeGeneration (enqueue) ──► 200 "generating"
                              │
                              ▼
                     Cloud Task (typical 60-110s observed)
                              │
                              ▼
render_item POST ──► poll loop (1-2.5s interval) ──► 200 "ready" + data
       │                      │
       │                      ▼
       │              item.generationStartedAt
       │              item.generationChars
       │              item.generationStatus
       │
       └──► MCP notifications/progress every 10s ("Generating… 20s")
```

### Existing Infrastructure

| Component | What it does | Where |
|-----------|--------------|-------|
| MCP progress notifications | Emits `notifications/progress` every 10s with elapsed seconds | `server.ts:703` |
| Console character progress | Writes `generationChars` to Firestore every 2s during generation | `generate-for-request.ts:277` |
| MCP server poll | Reads `generationStartedAt`/`generationChars` from item, shows "39s, ~2,040 tokens" | `tools.ts:1605-1607` |
| Startup catalog warm | Fires `warmCatalog()` at server start (unawaited) | `server.ts:1459` |
| Stale-while-revalidate | Returns stale catalog immediately, refreshes in background | `api.ts:744-746` |
| In-flight deduplication | Shares pending unfiltered catalog fetch across callers | `api.ts:714` |

### Polling Budgets (not measured latencies)

| Context | Budget | Interval | Rationale |
|---------|--------|----------|-----------|
| Widget host (Claude) | 8s | 1s | Host abandons slow calls at ~33s |
| Non-Claude render_item | 15s | 2.5s | Client classification selects budget; progress only shows on return |
| `get_item` programmatic | 45s | 2.5s | Scripts want the answer, not narration |

One tool call makes multiple upstream polls. Each upstream poll costs ~480ms
(measured 2026-09-04). An 8s budget with 1s interval = ~5-6 upstream polls.

### Cold-Start Catalog Behavior (Acceptable)

When a new Cloud Run instance starts, `warmCatalog()` fires but the console
may take ~18s to respond (cold start). If a session arrives before warming
completes:

1. `getCachedFullCatalog()` returns null
2. `SERVER_INSTRUCTIONS` tells the model to call `list_languages()`
3. First `list_languages()` uses 25s cold timeout
4. Subsequent calls have cache via stale-while-revalidate

This is acceptable behavior. Fixing it would require minimum instances (costs
money) or readiness gating (delays all requests). The fallback works and the
model adapts.

---

## Optimization Opportunities

### 1. Enrich MCP Progress with Console-Sourced Data (Potential High Impact—Host Validation Required)

**Current state**: MCP progress notifications say "Generating… 20s" — elapsed
wall-clock time only. The console writes character progress every 2s, but the
MCP server only sees it when it polls the item (1-2.5s intervals).

**Opportunity**: Push console progress to MCP server via SSE so notifications
carry real data ("20s, ~2,040 tokens") without polling for it.

```
Console                      MCP Server                    Client
   │                              │                           │
   │──── SSE: chars=8160 ────────►│                           │
   │                              │── progress: 20s, ~2040 ──►│
   │                              │                           │
```

**Cadence**: Each SSE update from the console triggers an MCP `notifications/progress`
at roughly the console's 2-second write interval. The existing 10-second elapsed-time
heartbeat remains only as fallback/keepalive when SSE is unavailable or disconnected.

**Scope clarification**: SSE does NOT replace the completion poll — `render_item`
still polls for terminal status (ready/failed) and fetches final data. The SSE
stream provides progress updates; the poll provides completion.

**Impact caveat**: "High impact" assumes ChatGPT and Claude visibly render
`notifications/progress` to users. Must validate host behavior before prioritizing.

**Security requirements** (not optional):
- Endpoint must authenticate the caller (free-plan session token or OAuth)
- Endpoint must verify caller has access to the requested item's workspace
- Item ID alone must never authorize subscription
- Consider short-lived item-subscription credential supplementing workspace check

**Design decisions needed**:
- Reconnect semantics (resume from last seen char count?)
- Terminal event format (how does SSE signal generation finished?)
- Timeout/fallback (if SSE connection fails, notifications continue at 10s with elapsed time only)
- Capacity planning (concurrent long-lived connections per Cloud Run instance)

**Repos**: Console (new endpoint), MCP server (subscribe + relay)

**Rollout**:
- Feature flag: `PROGRESS_SSE_ENABLED` (MCP server), console equivalent
- Rollback criteria (5-minute sliding window, minimum 20 connection attempts, denominator = attempts):
  - SSE connection error rate >5%
  - SSE connection timeout rate >10%
- Monitoring: connection duration, reconnect rate, chars-delivered latency

---

### 2. Reduce Console Post-Generation Delay (High Impact)

**Current state**: After generation completes, the console runs ~8 underlying
operations before marking the item "ready". Measured at 1,267-1,865ms via
`toReady` in `generate-job.ts:229` (compared against a single small L0000 model
call of 1,784ms in the same profiling run).

**Operations** (profile before prescribing parallelization):
1. `getItem` — re-read the item (~160ms)
2. `appendHelpEntry` — local computation (negligible)
3. `updateItem` — write taskId + help (~160ms)
4. `setItemGenerationStatus` — runs inside updateItem's `onRenderable` callback
5. Version/billing writes (~300ms measured)

Some are serial by necessity (can't flip status before taskId lands). The
re-read may be eliminable if the caller already has the item. Profile each
step before parallelizing.

**Repos**: Console only

**Rollout**:
- Feature flag: `PARALLEL_POST_GEN` or per-optimization flags
- Rollback criteria: generation failure rate increase, item corruption
- Monitoring: `toReady` p50/p95, per-step timing breakdown

---

### 3. Widget Bundle Prefetch (Needs Investigation)

**Hypothesis**: Preloading common language bundles (`L0180.mjs`, `L0175.mjs`)
could eliminate ~200ms fetch latency per render.

**Unknown**:
- Language usage distribution (which bundles are worth preloading?)
- Cache hit rates (are bundles already cached from prior renders?)
- Sandbox support (do `<link rel="modulepreload">` hints work in widget sandbox?)
- Size tradeoff (each bundle is ~80KB; preloading unused bundles wastes bandwidth)

**Required before prioritizing**:
- Instrument bundle fetch timing in widget beacon
- Measure cache hit rates across sessions
- Test modulepreload in ChatGPT/Claude widget sandboxes
- Analyze language distribution from `mcp_tool` events

**Repos**: MCP server (widget HTML)

---

## Already Done

| Optimization | Status | Where |
|--------------|--------|-------|
| Compact `render_item` response | Done | `tools.ts` — no `src`/`data` in response body |
| Widget hydration in `_meta` | Done | Hidden from model transcript |
| ETag revalidation for bundles | Done | `server.ts` — language `.mjs` files |
| Stale-while-revalidate catalog | Done | `api.ts:744-746` |
| In-flight catalog deduplication | Done | `api.ts:714` |

---

## Success Criteria

### Progress Metrics

Three separate clocks:

| Metric | Definition | Current | Target | Measurement |
|--------|------------|---------|--------|-------------|
| Create response latency | Time from `create_item` request to server response | <1s (create_item returns immediately) | <1s | Instrument create_item response time |
| Generation-start delay | Time from enqueue to first model output (first `generationChars` > 0) | Unknown | Baseline first | Console: timestamp of first `setItemGenerationChars` call |
| Progress delivery latency | Time from console `generationChars` write to client notification | Unknown | <2s (match console write interval) | Compare console write timestamp to MCP notification timestamp |

### End-to-End Outcomes

| Metric | Current (estimate) | Target | Measurement |
|--------|-------------------|--------|-------------|
| Time-to-ready p50 | Unknown | Baseline first | New event: enqueue timestamp to ready timestamp |
| Time-to-ready p95 | Unknown | Baseline first | Same |
| Post-generation delay p50 | 1.27-1.87s (3 samples) | <500ms | `toReady` from generate-job.ts:229 directly |
| Post-generation delay p95 | Unknown | Baseline first | Same |
| Upstream polls per item | Unknown | Baseline first | Aggregate poll counts across all render_item calls for same item_id |
| Upstream polls per call | ~5-6 (8s budget, 1s interval, 480ms/poll) | Same or fewer | Instrument poll count in handleItemResult |
| render_item calls per completion | Unknown | Baseline first | Count calls with same item_id until ready |
| Abandonment rate | Unknown | Baseline first | No subsequent retrieval within 5min, OR client disconnect/cancellation, OR host-reported failure |
| Generation failure rate | Unknown | No regression | generationStatus="failed" / total |

### Segmentation

All metrics should be segmented by:
- Client (claude-ai, claude-code, ChatGPT, Codex)
- Language (L0180, L0175, L0169, etc.)
- Cold-start state (first request on instance vs. warm)

---

## Rollout Plan

### Phase 1: Measurement (no user-visible changes)

- Add timing instrumentation to MCP progress notifications
- Add bundle fetch timing to widget beacon
- Emit `toReady` as structured event (or confirm it's already captured)
- Baseline all success criteria metrics
- Segment by client/language/cold-start

### Phase 2: Console Post-Generation (console repo)

- Profile the ~8 underlying operations with per-step timing
- Identify parallelization opportunities
- Implement behind `PARALLEL_POST_GEN` flag
- Deploy to staging, measure `toReady` improvement
- Gradual rollout: 10% → 50% → 100%
- Rollback if failure rate increases or items corrupt

### Phase 3: Progress Streaming (both repos)

- Design SSE endpoint with auth + workspace verification
- Implement in console behind flag
- Implement in MCP server behind `PROGRESS_SSE_ENABLED`
- Load test: concurrent connections, reconnect storms
- Test with ChatGPT, Claude, Codex
- Deploy with polling fallback (SSE failure → 10s notifications continue)
- Gradual rollout: 10% → 50% → 100%
- Monitor connection duration, error rate, chars-delivered latency

---

## Open Questions

1. **SSE capacity**: How many concurrent long-lived connections can a console
   Cloud Run instance handle? Does this need a dedicated service or Pub/Sub?

2. **Host progress rendering**: Do ChatGPT and Claude render `notifications/progress`
   the same way? Does either support a progress bar vs. just text?

3. **Cancellation**: If the user abandons the chat, how does the MCP server
   know to close the SSE connection? Does it matter (idle timeout)?

4. **Widget progress**: The widget has no `connectDomains`. If we want live
   progress in the widget itself (not just the host), options are:
   - Host bridge (Claude's ext-apps SDK has `sendMessage`?)
   - Poll via the same dynamic import trick used for beacons
   - Accept that widget only shows final state (current behavior)
