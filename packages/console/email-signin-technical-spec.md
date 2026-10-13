# Email Sign-In Technical Spec
## New User Authentication for console.graffiticode.org

*Companion to: trial-access-technical-spec.md, Artcompiler Brand Playbook*
*April 2026*

---

## Problem

The Graffiticode console sign-in modal currently offers two options:

```
┌──────────────────────────────────────────┐
│  Sign in                                 │
│                                          │
│  ◆  Continue with Ethereum Wallet        │
│                                          │
│  G  Continue with Google                 │
│                                          │
│  * Google sign-in requires a linked      │
│    Ethereum account                      │
└──────────────────────────────────────────┘
```

"Continue with Google" is a sign-in shortcut that only works for users who have already linked a Google account in settings — it is not a general-purpose sign-in method and is not useful for new users. More fundamentally, Google is used in Graffiticode for OAuth authentication (linking an OAuth identity to an existing account), not as a primary credential. Surfacing it in the sign-in modal conflates two different concepts and creates confusion.

New users who don't own a wallet (the majority of the QuestionCompiler ICP) have no working sign-in path. The console is unreachable for them without installing MetaMask.

---

## Solution

Remove "Continue with Google" from the sign-in modal entirely. Replace it with **email magic link sign-in** as a first-class option alongside the existing Ethereum Wallet path. **Privy** (`@privy-io/react-auth`) is the embedded wallet provider; it handles keypair generation transparently. The user enters their email, receives a magic link, clicks it, and lands in the console with a fully provisioned Graffiticode account. From Graffiticode's perspective the result is identical to SIWE — a valid Ethereum address and signature are present; no special handling is needed.

Google remains available as an OAuth authentication method for linking a Google identity to an existing account, accessible from account settings. It is not a sign-in method and does not appear in the sign-in modal.

---

## New Sign-In Modal

```
┌──────────────────────────────────────────┐
│  Sign in to Graffiticode                 │
│                                          │
│  New here? Create a free account by      │
│  signing in. No blockchain fees.         │
│  No credit card required.                │
│                                          │
│  ◆  Continue with Ethereum Wallet        │
│                                          │
│           ─── or ───                     │
│                                          │
│  ✉  Continue with Email                  │
│                                          │
└──────────────────────────────────────────┘
```

**"Continue with Ethereum Wallet"** — existing SIWE flow, unchanged.

**"Continue with Email"** — new path. User enters their email address, receives a magic link, and clicks it. The embedded wallet provider silently generates an Ethereum keypair associated with their email. Graffiticode receives the resulting address and treats the session as a normal wallet sign-in. No footnote, no pre-linking step, no wallet software required.

---

## How It Works

### Email Magic Link Flow (Step by Step)

1. User clicks "Continue with Email" on the console sign-in modal.
2. Console presents an email input field (inline, no page navigation).
3. User enters their email and submits.
4. Console calls Privy's `loginWithEmail({ email })` to initiate the magic-link flow.
5. Privy sends a magic-link email to the user.
6. User clicks the magic link (opens in same browser session or can be pasted).
7. Privy completes authentication. After `authenticated === true`, the console reads Privy's embedded wallet via `useWallets()` (filtered to `walletClientType === 'privy'`) and obtains the wallet's EIP-1193 provider.
8. The console runs the **existing SIWE handshake** with that provider as the signer: `client.ethereum.getNonce({ address }) → provider.request({ method: 'personal_sign', params: ["Nonce: <nonce>", address] }) → client.ethereum.authenticate({ address, nonce, signature }) → firebaseCustomToken → signInWithCustomToken`. This is the same pipeline used today by `src/hooks/use-ethereum.ts`; only the signing source differs.
9. User is in the console with a real Graffiticode account. No blockchain interaction visible.

### Email Address Storage

The verified email address is persisted on the Firestore user document as `signInEmail` (and `signInEmailVerifiedAt`) at first sign-in. It is rendered **read-only** in the Profile panel directly under User ID / Ethereum address.

The `signInEmail` field is intentionally distinct from `notificationEmail`. `notificationEmail` initializes blank and is only populated if the user explicitly opts into notifications in Profile. The Settings page's `OAuthCard` continues to manage Google-linked email addresses for OAuth account linking; it is unrelated to `signInEmail`.

### What Graffiticode Sees

From the Graffiticode API's perspective, email sign-in is indistinguishable from SIWE after step 8. Both paths produce an authenticated Ethereum address. No new account types, no schema changes, no special flags.

Privy is a client-side concern. The console integrates the Privy SDK; the Graffiticode backend (auth.graffiticode.org and api.graffiticode.org) never communicates with Privy directly.

### Keypair Custody

Privy holds the private key. The user does not have direct access to it by default. This is intentional — most QuestionCompiler users don't need or want self-custody. For users who later want to migrate to a hardware wallet or MetaMask, account settings will expose a key export option using Privy's export-key flow. This is the self-custody upgrade path; it is optional and not promoted in the primary onboarding flow.

---

## Connection to the MCP Trial Claim Flow

Email sign-in is the primary completion step for users who arrive via the MCP trial channel. The flow connects the agent's chat interface directly to the console sign-in described in this spec.

### What the Agent Receives

Every `create_item` (and `update_item`) response from the MCP server when using the trial token includes three extra fields alongside the normal item data:

```json
{
  "item_id": "abc123",
  "data": { ... },
  "preview_url": "https://preview.graffiticode.org/items/abc123",
  "claim_url": "https://console.graffiticode.org/claim?token=eyJ...",
  "claim_message": "Your item is ready. To save it permanently, sign in at: https://console.graffiticode.org/claim?token=eyJ..."
}
```

The agent surfaces `claim_message` as a chat message to the user. In environments that support it (Claude Desktop, Cowork), `preview_url` opens automatically in a browser tab so the user can see the item immediately without signing in.

### What Happens When the User Clicks the Claim URL

The `claim_url` contains a short-lived signed JWT (24-hour expiry) that identifies the session and its items. Clicking it opens the `/claim` page — a focused variant of the sign-in modal with copy about saving items rather than general account creation:

```
┌──────────────────────────────────────────┐
│  Save your items                         │
│                                          │
│  Sign in to keep these items permanently │
│                                          │
│  ◆  Sign in with Ethereum Wallet         │
│                                          │
│           ─── or ───                     │
│                                          │
│  ✉  Continue with Email                  │
│     (creates a new Graffiticode account) │
└──────────────────────────────────────────┘
```

The user chooses email (most likely for a first-time user) or Ethereum wallet (for an existing account holder). Either path completes the same way: all items from the session are copied to the authenticated account, the user lands in the console with their items already loaded, and the trial originals are reaped naturally by the existing 48-hour `expiresAt` TTL.

The underlying email magic link mechanism on `/claim` is identical to the main sign-in modal — the same Privy SDK, the same keypair generation, the same Graffiticode account creation. No separate implementation is needed.

### Claim Mechanics (Path A: Firestore-only with lazy task repost)

The trial-claim is implemented entirely in the console — **zero changes to api.graffiticode.org**. The mechanism leans on a property the codebase already has: `getItems` in `src/pages/api/resolvers.ts` (lines 670–696) re-posts a task under the *current* auth whenever it sees a Firestore item with `taskId == null && data.code` set. Two small additions make this load-bearing for claim:

1. **`createItem` persists the parsed AST.** Trial-`createItem` writes `code` (the AST already in scope from the `postTask` call) onto the Firestore item doc. This applies to all creates, not just free-plan — it also makes the existing `shareItem` flow work end-to-end as its inline comment originally intended.

2. **`getItem` mirrors the lazy-repost guard.** The same `if (!taskId && data.code) { postTask + update }` block lives in `getItem` so the MCP read path (`get_item`) returns a real `taskId` for freshly claimed items, not `null`.

With those in place, `claimFreePlanSession(token)` is a Firestore-only mutation:

1. Verify the request comes from a real authenticated uid (not a free-plan session).
2. Verify the JWT against `FREE_PLAN_NAMESPACE_SALT` (HS256, 24h, claims: `sessionNamespace`, `sessionUuid`, `aud: 'graffiticode-claim'`).
3. Resolve the trial uid via `getFreePlanCredentials()` — the owner of `FREE_PLAN_API_KEY`.
4. Query `users/{trialUid}/items` where `freePlan == true && sessionNamespace == payload.sessionNamespace && expiresAt > now`.
5. For each match, write a copy under `users/{ctx.auth.uid}/items/{newId}` with `taskId: null`, `code` preserved, `freePlan`/`sessionNamespace`/`expiresAt` cleared, `claimedFrom: payload.sessionUuid` for provenance, and `app: 'mcp'` retained.
6. Return `{ transferred, sessionNamespace }`.

Trial copies are **not deleted** — `expiresAt` reaps them, and keeping them under the shared `FREE_PLAN_API_KEY` uid preserves cross-trial analytics in one account.

### Why the shared `FREE_PLAN_API_KEY` uid model is retained

A "heavier" alternative was considered: have the console generate a real Ethereum keypair per trial session, run SIWE server-side, mint a real per-trial Firebase identity, and use that as the trial uid throughout. That would eliminate the `freePlan`/`sessionNamespace` plumbing, give each trial its own auth boundary, and reduce blast radius if `FREE_PLAN_API_KEY` is ever compromised.

It was rejected for now because:
- It is roughly 4× the surface area: server-side keypair generation, a `createTrialSession` mutation, MCP-side Firebase token storage and refresh, an auth-service capacity question for per-trial signups, and a sweep job for unclaimed accounts.
- The same task-relocation work is still required at claim time (tasks would otherwise remain owned by the trial uid).
- Path A's shared-uid model makes cross-trial analytics trivial — one account, all items. The heavier model would silo each trial.

The heavier model can land independently as a future architectural cleanup if `FREE_PLAN_API_KEY` rotation or per-uid rate-limiting becomes operationally pressing.

### Future Iteration Note

The current design requires the user to click a link out of the chat interface to complete sign-in. A future iteration could tighten this loop:

- **In-chat sign-in prompt**: MCP host environments (Claude Desktop, Cowork) could surface an inline sign-in widget directly in the chat pane, so the user never leaves the conversation to claim their items.
- **Persistent claim link**: The claim JWT currently expires in 24 hours. Extending this (or making the link re-issuable on demand) would reduce friction for users who don't act immediately.
- **Proactive claim reminder**: If a session account nears its 7-day TTL with items unclaimed, the MCP server could include a reminder in the next `update_item` response prompting the user to claim before expiry.
- **Post-claim continuation**: After a successful claim, redirect the user back into their agent session rather than dropping them in the console root — so the conversation can continue in an authenticated context.

See `trial-access-technical-spec.md` for the full MCP trial flow, session account lifecycle, rate limiting, and item transfer mechanics.

---

## Embedded Wallet Provider

**Decision:** Privy (`@privy-io/react-auth`).

### Scope of Integration

Privy is integrated in two places:

1. **Main console sign-in modal** — "Continue with Email" button. Handles email input, magic link dispatch, and keypair generation.
2. **`/claim` page** — "Continue with Email" button (same flow, different copy).

Privy is not involved in SIWE sign-in or any backend Graffiticode API calls. `<PrivyProvider>` is mounted in `src/pages/_app.tsx` inside `<GraffiticodeFirebaseProvider>` and outside `<WagmiProvider>`. `WagmiProvider` is retained for the existing wallet flow.

### Evaluation Criteria

| Criterion | Notes |
|---|---|
| Email magic link sign-in | Required. Must work without any wallet software on the user's device. |
| Ethereum keypair generation | Required. Provider must generate and manage a real Ethereum keypair per user identity. |
| Key export / self-custody path | Required. Users must be able to export their private key from account settings if they later want MetaMask. |
| Key custody model | Preferred: provider holds keys, not Artcompiler. Eliminates custodial liability. |
| React / Next.js SDK | Required. Console is a React application. |
| Pricing at low volume | Trial / free tier for under 1,000 monthly active users would be ideal at launch. |
| No required blockchain transaction | Required. New users must be able to sign in without paying gas fees or approving on-chain transactions. |

### Candidates Considered

**Privy** *(chosen)* — purpose-built for progressive wallet onboarding. Email magic link is a primary use case. Supports key export. Well-documented React SDK. Widely used in web3 apps targeting non-crypto audiences.

**Dynamic** — similar positioning to Privy. Slightly more enterprise-oriented pricing. Also supports email, social, and SIWE under one SDK. Acceptable fallback if Privy's pricing or support terms become unfavorable.

**Web3Auth** — more infrastructure-oriented (MPC key management). More powerful but more complex to integrate. Better suited if Artcompiler plans to offer key sharding or threshold recovery. Out of scope for now.

---

## Changes Required

### console.graffiticode.org

- Mount `<PrivyProvider>` in `src/pages/_app.tsx` (inside `<GraffiticodeFirebaseProvider>`, outside `<WagmiProvider>`). Configure `loginMethods: ['email']` and `embeddedWallets: { createOnLogin: 'users-without-wallets' }`.
- Rewrite `src/components/AuthMethodDialog.tsx`: remove "Continue with Google", remove the footnote, add "Continue with Email" with an inline email-input pane that renders in place on click. Add a `variant: 'default' | 'claim'` prop so the same component can serve `/claim`.
- New `src/hooks/use-email-signin.ts`: wraps Privy's `useLoginWithEmail` and `useWallets`. After Privy authenticates, runs the existing SIWE handshake against `client.ethereum` using Privy's embedded-wallet provider as the signer, returns the resulting Firebase custom token to the auth context.
- Extend `src/hooks/use-graffiticode-auth.tsx` with `signInWithEmail()`. On first sign-in, idempotently `PUT /api/user/<uid>` with `{ signInEmail, signInEmailVerifiedAt }`.
- Extend `src/pages/api/user/[name].ts` to allow PUT of `signInEmail` and `signInEmailVerifiedAt`.
- Render `signInEmail` read-only in the Profile panel (`src/pages/profile.tsx`) directly under User ID.
- Add `src/pages/claim.tsx` — reads `?token=<jwt>`, renders `<AuthMethodDialog variant="claim" />`, calls `claimFreePlanSession(token)` on successful sign-in, then redirects to `/items`.
- Two small additions to `src/pages/api/resolvers.ts` to enable the lazy task-repost claim mechanic:
  - `createItem` persists the parsed AST as `code` on the Firestore item doc.
  - `getItem` adds the same `if (!taskId && data.code) { postTask + update }` guard already present in `getItems`.
- New `src/pages/api/index.ts` mutation `claimFreePlanSession(token)` — Firestore-only copy of trial items into the authenticated user's `users/{uid}/items/` collection (see "Claim Mechanics" above).
- New `src/lib/claim-token.ts` exposing `verifyClaimToken(jwt)` for the resolver. The minter is in the MCP repo; document the contract (HS256, 24h, claims) so the two implementations stay in sync.

### Graffiticode API / Backend

No schema changes required. Email sign-in produces a standard Ethereum address; the existing account model handles it.

The `signInEmail` field is stored on the Firestore user document (in the console's project) at first sign-in. This is decided, not optional.

### Infrastructure

- `next.config.mjs` — add a CSP `headers()` block allowing Privy origins in `connect-src`, `frame-src`, `script-src` (`https://auth.privy.io`, `https://*.privy.io`, `wss://*.privy.io`). Run report-only on first deploy.
- `NEXT_PUBLIC_PRIVY_APP_ID` is added to `.env.development`, `.env.local`, and the Cloud Run env via `scripts/set-free-plan-secrets.sh` (or a sibling script).
- No new backend infrastructure — Privy operates entirely client-side.

---

## What Does Not Change

- The SIWE sign-in flow is unchanged.
- Google OAuth for account linking (in account settings) is unchanged. Existing users who have linked a Google account retain that link and can use it for OAuth-authenticated actions within the platform.
- The Graffiticode API, account model, and item storage are unchanged.
- Compile fees, rate limiting, and all other platform mechanics are unchanged.
- No existing user data is migrated or modified.

## Migration: Existing Google Sign-In Users

**Decision: cutover without audit.** The "Continue with Google" path required a pre-linked Ethereum account, which effectively blocked new Google sign-ins, so the affected set is expected to be near-empty. Existing Google-linked accounts retain that link in account settings and can still sign in via Ethereum Wallet. No migration email and no account audit is performed.

---

## Open Questions

**Magic link expiry.** Privy's magic links expire after 15–30 minutes. Confirm Privy's UX handles "link expired, request a new one" gracefully and verify our error surface matches. Validate during implementation.

**Same-device requirement.** Some magic-link implementations require the link to be opened in the same browser that initiated the flow. Verify Privy's cross-browser handling on mobile (email app opens link in a different browser than the one that submitted) during implementation, or accept and document the limitation.

**Google OAuth scope clarification in other docs.** References to Google sign-in in `trial-access-technical-spec.md` and the brand playbook should be updated to reflect that Google is an OAuth method for account linking only, not a sign-in path. Audit those documents after this spec is approved.

## Resolved Decisions (previously open)

- **Provider:** Privy.
- **Email storage:** Persisted as `signInEmail` on the Firestore user doc; rendered read-only in Profile under User ID. Distinct from `notificationEmail` (which initializes blank and is opt-in) and from Settings-page OAuth-linked emails.
- **Trial-claim architecture:** Path A — keep the shared `FREE_PLAN_API_KEY` uid + `sessionNamespace` model. Claim is a Firestore-only copy that leverages the existing lazy task-repost mechanism. Per-session keypairs (Path B) are documented as a deferred architectural cleanup.
- **Migration of existing Google sign-in users:** cutover without audit (see Migration section above).
