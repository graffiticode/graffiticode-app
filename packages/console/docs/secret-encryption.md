# Shared secret encryption (retired)

`get-val-private` used to carry account secrets: the console encrypted each value
with `GRAFFITICODE_SECRET_KEY` at parse time, the parser baked the ciphertext into
the task AST, and compilers holding the same key decrypted it at compile time.

That path is retired (capability spec SECRET-01: credentials never enter task ASTs,
compile configuration or compiler processes):

- **Credentials card retired 2026-09-28.** Parse supplies only `itemId` (public).
- **Stored secrets deleted 2026-10-02.** The `users/{uid}/settings` secret docs are
  gone for every user, and the one real credential found baked into stored L0158/L0176
  tasks was retired at its provider.
- **No encryption.** `get-val-private "<name>"` now bakes `""` without encrypting
  (`src/lib/task-api.ts`). That is the value such programs already received. The
  console has no `secret-crypto` module and needs no `GRAFFITICODE_SECRET_KEY`;
  `scripts/set-compiler-secret.sh` is removed.
- **Compilers.** The key is being unmounted from `l0176` and `l0158`, after which it
  is destroyed. Ciphertext left in old task ASTs then decrypts to nothing anywhere.

External APIs are reached only through a connection (Policy plus credential Broker).
An L0176 item with no connection previews with the service's configured keys.
