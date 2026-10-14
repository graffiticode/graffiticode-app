# Behaviour baseline (Phase 0.5)

Characterization tests that pin how the console and the MCP tools behave today,
before Phase 1 moves the domain logic into `packages/core`. They must pass
**unchanged** through Phases 1–3; editing one there means behaviour changed.

Each test file runs the console's GraphQL handler in-process (`harness.ts`)
against the Firestore emulator. Everything else is faked on loopback: the
backend API and auth service (bent), Policy (fetch), Anthropic (axios), and
the generation worker, which runs in-process. Any other network call fails
the run (`harness.external`).

```bash
npm run test:baseline        # needs Java 21 for the emulator
```

On macOS with Homebrew's keg-only `openjdk@21`, put it on `PATH` first:
`export PATH="/opt/homebrew/opt/openjdk@21/bin:$PATH"`.

Files run one at a time (`--test-concurrency=1`) because they share one
emulator and each test clears it.

Known bug pinned here, not fixed: `writes.test.ts` "KNOWN BUG: GraphQL drops
checkable, confirmed and reconcile from lastWrite".
