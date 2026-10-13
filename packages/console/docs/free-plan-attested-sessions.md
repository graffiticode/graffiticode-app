# Free-plan attested sessions — cutover runbook

Turning on `FREE_PLAN_REQUIRE_SIGNED_SESSION` is what makes anonymous quota
enforceable. Until it's set, a raw `curl` with a fresh uuid in
`X-Free-Plan-Session` is a valid free-plan session with fresh limits, and per-key
limits mean little because minting a new key costs nothing.

The switch is **not** safe to flip on its own — it must follow the deploy order
below, because both services sign with the same secret and the MCP server has to
be issuing signed tokens before the console starts refusing unsigned ones.

## What the token is

The MCP server mints an HS256 JWT at `initialize` (`mcp/src/session-token.ts`)
and presents it as `X-Free-Plan-Session`. The console verifies it
(`console/src/lib/free-plan-session-token.ts`) and takes the namespace from the
payload rather than hashing the header.

| | |
|---|---|
| Secret | `FREE_PLAN_NAMESPACE_SALT` — the **same value** on both services |
| Audience | `graffiticode-session` (claim tokens use `graffiticode-claim`; they are not interchangeable) |
| Expiry | 48h, matching `FREE_PLAN_ITEM_TTL_MS` |
| Payload | `{ sessionNamespace, sessionUuid }` |

Once the console has answered a call it returns a `workspace` handle, which the
MCP server presents from then on in place of its own token. That is what keeps a
client in one workspace across the transport sessions it keeps losing — see
`docs/language-routing-and-composition.md` for the wider free-plan model.

This is the **only** signing contract duplicated across the two repos; claim
tokens are minted solely by the console. It's pinned by
`mcp/tests/free-plan-workspace.test.ts` ("matches the console's verifier
contract"). If you change any parameter, change it in both places in the same
release, or every free-plan session breaks the moment the switch is on.

## Cutover order

1. **Confirm the salt matches.** Both services must already share
   `FREE_PLAN_NAMESPACE_SALT` (they do — the claim flow depends on it). Rotating
   it invalidates every outstanding claim JWT and orphans every namespaced item,
   so don't combine a rotation with this cutover.
2. **Deploy the console.** It accepts both forms: signed tokens verified, raw
   uuids still hashed. No client-visible change.
3. **Deploy the MCP server.** It now presents signed tokens. Verify with
   `npm run gcp:logs` that free-plan tool calls still succeed.
4. **Soak.** In-memory MCP sessions die on restart anyway, so there is no
   long-lived unsigned population to strand — a few minutes is enough to confirm
   creates and claims work.
5. **Flip the switch.** Set `FREE_PLAN_REQUIRE_SIGNED_SESSION=true` on the
   console and redeploy. Unsigned sessions now get a structured 401
   (`free_plan_session_invalid`) pointing at signup.

Rollback is unsetting the variable; nothing persisted depends on it.

### Verifying the boundary closed

```bash
# Must succeed before the flip, 401 after.
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://console.graffiticode.org/api \
  -H 'Content-Type: application/json' \
  -H 'X-Free-Plan-Session: anything-at-all' \
  -d '{"query":"{ items(lang:\"0166\") { id } }"}'

# Same against the compile proxy.
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://console.graffiticode.org/api/compile \
  -H 'Content-Type: application/json' \
  -H 'X-Free-Plan-Session: anything-at-all' -d '{}'
```

A real client must keep working throughout: connect the MCP server with no
credentials, `create_item` → `render_item` → `update_item` → open `view_url` →
claim.

## Cloudflare rate limiting (manual, dashboard)

With the switch on, a session can only be obtained from the MCP `initialize`
endpoint, which makes that endpoint the single door worth limiting — and it's the
one hop where the client's own IP is visible. Nothing is read in-app: the raw
client IP is never touched by our runtime, only by the edge (see the privacy
statement in `mcp/docs/openai-submission.md`).

Rule on `mcp.graffiticode.org`:

- **Match:** `http.request.method eq "POST" and not any(http.request.headers["authorization"][*] ne "")`
- **Characteristic:** IP
- **Rate:** ~30/minute and ~300/hour
- **Action:** managed challenge is useless against agents — use *Block* with a 429.

**Sizing note, and the reason this rule is loose:** session-minting is not rare
for legitimate traffic. ChatGPT opens a new MCP session *per tool call*, so a
normal conversation legitimately mints many. The rule has to clear that with
margin; what it still catches is a scripted minting loop, which runs orders of
magnitude faster than any conversation. Do not tighten it toward "a few sessions
per user" — that describes Claude's behaviour, not ChatGPT's.

There is deliberately **no** matching rule on `console.graffiticode.org`: all
MCP→console traffic egresses from a single address, so an IP rule there would
throttle every anonymous user at once. On the console, signature rejection is the
defense, and it's cheap — no LLM call, no Firestore read.

## In-app rate limits (already deployed)

Per-surface sliding windows keyed on the workspace, `BURST` in
`src/lib/free-plan-throttle.ts`. These are hammering guards, **not** the budget —
the budget is items (`docs/item-based-pricing.md`).

| Surface | Default | Env | Why |
|---|---|---|---|
| Generation | 5/60s | `FREE_PLAN_BURST_LIMIT` | The only genuinely expensive call |
| API (all GraphQL) | 120/60s | `FREE_PLAN_API_BURST_LIMIT` | Must clear `get_item`'s long-poll: 2.5s interval for up to 45s is ~18 requests from **one** tool call, and a generation runs 60–110s |
| Compile proxy | 30/60s | `FREE_PLAN_COMPILE_BURST_LIMIT` | Reaches a compiler service |

Window length is shared: `FREE_PLAN_BURST_WINDOW_SECONDS` (default 60).

If you lower the API ceiling, check it against the long-poll arithmetic first —
setting it near the generation limit breaks the first item a new user creates,
which is precisely the encounter the free plan exists to win.
