# `/form/{id}` state machine

What happens when a user visits `app.graffiticode.org/form/{id}`.

The page (`src/app/form/[id]/page.tsx`) is a client component. It resolves the
URL segment with `useSWR` keyed on `[id, !!user]`, so the resolve re-runs every
time the **signed-in state flips** (sign-in / sign-out) — that re-resolution is
what makes sign-in / switch-account feel circular. For item-backed forms SWR also
polls the resolve every 8s and revalidates on focus/reconnect, so a task the
creator edits elsewhere is picked up and the form auto-reloads.

## Client-visible states

```mermaid
stateDiagram-v2
    [*] --> Loading : visit /form/{id}

    state "Loading — spinner" as Loading
    state "Rendered — form iframe" as Rendered
    state "Sign in to view this form" as SignIn
    state "This form is private" as Private
    state "Not found" as NotFound
    state "Something went wrong" as Error
    state decide <<choice>>

    Loading --> decide : GET /api/form/resolve?id (token if a user exists)
    decide --> Rendered : allowed
    decide --> SignIn : denied · no user
    decide --> Private : denied · user · reason=locked
    decide --> NotFound : denied · user · reason=not-found
    decide --> Error : request threw

    SignIn --> Loading : sign-in succeeds (user set)
    Private --> Loading : "Switch account" → signOut (user cleared)
    Error --> Loading : reload

    Rendered --> [*]
    NotFound --> [*]

    note right of Loading
        Spinner while auth is loading
        OR the first resolve is in flight.
        SWR re-resolves when the signed-in
        state flips (key = !!user).
    end note
    note right of Private
        RequestAccess view:
        • Switch account (signOut)
        • Request access (mailto owner, if known)
    end note
    note right of Rendered
        FormHarness mounts an <iframe> to
        api /form?id=&access_token=&origin=
        with its own load spinner until the
        iframe posts data-updated / onload.
        It reloads the iframe when the
        resolved taskId changes (head edit).
    end note
```

| State | Condition | What the user sees |
|---|---|---|
| **Loading** | auth `loading`, or first resolve in flight | spinner |
| **Rendered** | `allowed` | the form (`FormHarness` iframe) |
| **SignIn** | `denied` & `!user` | "Sign in to view this form" + Sign in |
| **Private** | `denied` & `user` & `reason=locked` | "This form is private" + Switch account / Request access |
| **NotFound** | `denied` & `user` & `reason=not-found` | "Not found" |
| **Error** | resolve threw | "Something went wrong" |

## Server resolve decision (inside the Loading → decide edge)

`/api/form/resolve` (`resolvers.ts`) maps the URL segment to a task id, then asks
the api store whether the viewer may see it.

```mermaid
flowchart TD
    Q["GET /api/form/resolve?id"] --> FORM{"looksLikeFormId?<br/>base64 {taskIds:[]}"}
    FORM -- yes --> TID["target = id<br/>(no itemId)"]
    FORM -- no --> AUTH{"signed in?"}
    AUTH -- yes --> DIR["direct: users/{uid}/items/{id}"]
    DIR -- found --> TITEM["target = item.taskId<br/>itemId + ownerUid set"]
    DIR -- miss --> CG["findItemById<br/>collection-group items.id<br/>(needs the COLLECTION_GROUP index)"]
    AUTH -- no --> CG
    CG -- found --> TITEM
    CG -- "miss / throws" --> TID
    TID --> HEAD["headId = taskId.split('+')[0]"]
    TITEM --> HEAD
    HEAD --> EVAL["evaluateAccess:<br/>GET api /task?id=headId (token if present)"]
    EVAL -- "2xx" --> ALLOW(["allowed → Rendered"])
    EVAL -- "401/403 → locked, 400/404 → not-found, other → locked" --> OVR{"resolved a real item?<br/>(itemId set)"}
    OVR -- yes --> LOCK(["reason = locked → SignIn (anon) / Private (signed in)"])
    OVR -- no --> KEEP(["reason = access.reason → NotFound, or locked"])
```

The `itemId set → reason=locked` override is the recent fix: a resolved item
provably exists, so a denial means "you can't see this" (prompt sign-in /
switch-account), never the dead-end "Not found". Only ids that don't resolve to
a real item (a bad id, or a base64 form id the api can't find) report
`not-found`.

## Why the flow feels weird

1. **Stale session → Private instead of SignIn.** A visitor who feels "logged
   out" but whose `useGraffiticodeAuth` still returns a non-null `user` skips the
   SignIn branch and lands on Private ("Switch account"). The branch is chosen by
   `!user`, not by token validity.

2. **Switch account is a two-hop.** Private's "Switch account" only calls
   `signOut`; that clears `user` → the SWR key (`!!user`) flips → re-resolve as
   anonymous → SignIn. The user then signs in. There is no single "sign in as a
   different account" action.

3. **Sign-in can bounce back.** After SignIn succeeds, SWR re-resolves with the
   new token. If that account also lacks access, it returns to Private — so it
   can look like signing in "did nothing".

4. **Two spinners.** Loading (resolve) hands off to Rendered, which shows its own
   FormHarness spinner until the iframe posts back — a brief double-spinner.
