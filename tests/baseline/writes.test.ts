// Connection writes (capability W4) and the W5 reconciliation check, for the
// connectable language L0176, against a fake Policy and a fake /compile.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { start, userToken, type Harness } from "./harness";
import { createItem, errorOf, getItem, ok } from "./helpers";

let h: Harness;
before(async () => { h = await start(); });
after(async () => { await h?.stop(); });
beforeEach(async () => {
  await h.resetFirestore();
  h.enablePolicy();
  h.setConnections([{ connectionId: "conn-1", backend: "learnosity", status: "active", label: "Item bank", ownerPermissions: null }]);
});

const alice = { token: userToken("alice") };
const saveKey = (itemId: string, taskId: string, connectionId = "conn-1") =>
  `save:${createHash("sha256").update(`${itemId}|${taskId}|${connectionId}`).digest("hex")}`;
const compiles = () => h.calls.filter(c => c.method === "POST" && c.path === "/compile").map(c => c.body);
const uncertain = () => ({ status: 200, body: { status: "error", errors: [{ message: "the save is uncertain", code: "uncertain" }] } });

async function storedLastWrite(itemId: string) {
  return (await h.db.doc(`users/alice/items/${itemId}`).get()).data()?.lastWrite;
}

test("a new version writes through the current connection with a deterministic key", async () => {
  const item = await createItem(h, alice, { lang: "0176" });
  const writes = compiles();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], { id: item.taskId, data: {}, connectionId: "conn-1", idempotencyKey: saveKey(item.id, item.taskId) });
  assert.equal(item.lastWrite.status, "ok");
  assert.equal(item.lastWrite.connectionId, "conn-1");
  assert.equal(item.lastWrite.checkable, false);
  const stored = await storedLastWrite(item.id);
  assert.equal(stored.idempotencyKey, saveKey(item.id, item.taskId), "lastWrite records the key the attempt used");
});

test("an uncertain write is recorded as a failure with the key it used", async () => {
  h.setCompile(uncertain);
  const item = await createItem(h, alice, { lang: "0176" });
  assert.equal(item.lastWrite.status, "failed");
  assert.match(item.lastWrite.message, /uncertain/);
  const stored = await storedLastWrite(item.id);
  assert.equal(stored.idempotencyKey, saveKey(item.id, item.taskId));
});

// GraphQL exposes the W5 state of lastWrite (fixed in PR #5; before it,
// checkable was always false and confirmed/reconcile always null).
test("GraphQL lastWrite carries checkable, confirmed and the latest check", async () => {
  h.setCompile(uncertain);
  const item = await createItem(h, alice, { lang: "0176" });
  assert.equal(item.lastWrite.checkable, true, "an uncertain save with its key stored can be checked");
  h.setReconcile(() => ({ status: 200, body: { status: "success", data: { operations: [{ verdict: "unresolved", records: [] }] } } }));
  const u = ok(await h.gql(CHECK, { id: item.id }, alice)).reconcileItemWrite.lastWrite;
  assert.equal(u.reconcile.verdict, "unresolved");
  assert.equal(u.checkable, true, "still checkable after an unresolved check");
  assert.ok(!u.confirmed);
  h.setReconcile(() => ({ status: 200, body: { status: "success", data: { operations: [{ verdict: "applied", final: true }] } } }));
  const a = ok(await h.gql(CHECK, { id: item.id }, alice)).reconcileItemWrite.lastWrite;
  assert.equal(a.status, "ok");
  assert.equal(a.confirmed, true);
  assert.equal(a.reconcile.verdict, "applied");
  assert.equal(a.checkable, false, "a confirmed save is no longer checkable");
});

test("retry replays the same key; recompile writes under a fresh key", async () => {
  h.setCompile(uncertain);
  const item = await createItem(h, alice, { lang: "0176" });
  ok(await h.gql(`mutation($id:String!){ retryItemWrite(id:$id){ id } }`, { id: item.id }, alice));
  const [first, retry] = compiles();
  assert.equal(retry.idempotencyKey, first.idempotencyKey);
  h.setCompile(() => ({ status: 200, body: { status: "success", data: {} } }));
  const r = ok(await h.gql(`mutation($id:String!){ recompileItem(id:$id){ lastWrite { status } } }`, { id: item.id }, alice)).recompileItem;
  const recompile = compiles().at(-1);
  assert.match(recompile.idempotencyKey, /^recompile:[0-9a-f-]{36}$/);
  assert.equal(r.lastWrite.status, "ok");
  assert.equal((await storedLastWrite(item.id)).idempotencyKey, recompile.idempotencyKey, "the check targets the key stored last");
});

test("a failure never replaces a success for the same version", async () => {
  const item = await createItem(h, alice, { lang: "0176" });
  assert.equal(item.lastWrite.status, "ok");
  h.setCompile(uncertain);
  ok(await h.gql(`mutation($id:String!){ retryItemWrite(id:$id){ id } }`, { id: item.id }, alice));
  assert.equal((await storedLastWrite(item.id)).status, "ok");
});

test("a new version's outcome replaces an earlier failure", async () => {
  h.setCompile(uncertain);
  const item = await createItem(h, alice, { lang: "0176" });
  h.setCompile(() => ({ status: 200, body: { status: "success", data: {} } }));
  const taskId = h.addTask({ lang: "0176", code: { root: "v2" } });
  const updated = ok(await h.gql(`mutation($id:String!,$t:String!){ updateItem(id:$id, taskId:$t){ taskId lastWrite { taskId status } } }`,
    { id: item.id, t: taskId }, alice)).updateItem;
  assert.equal(updated.lastWrite.taskId, taskId);
  assert.equal(updated.lastWrite.status, "ok");
  assert.equal(compiles().at(-1).idempotencyKey, saveKey(item.id, taskId));
});

const CHECK = `mutation($id:String!){ reconcileItemWrite(id:$id){ lastWrite { status confirmed checkable reconcile { verdict text } } } }`;

test("the W5 check confirms an applied save and turns it into a success", async () => {
  h.setCompile(uncertain);
  const item = await createItem(h, alice, { lang: "0176" });
  let asked: any;
  h.setReconcile(req => { asked = req; return { status: 200, body: { status: "success", data: { operations: [{ verdict: "applied", final: true }] } } }; });
  const w = ok(await h.gql(CHECK, { id: item.id }, alice)).reconcileItemWrite.lastWrite;
  assert.deepEqual(asked, { connectionId: "conn-1", idempotencyKey: saveKey(item.id, item.taskId) }, "checked by the stored key");
  assert.equal(w.status, "ok");
  const stored = await storedLastWrite(item.id);
  assert.equal(stored.status, "ok");
  assert.equal(stored.confirmed, true);
  assert.equal(stored.reconcile.verdict, "applied");
  assert.equal(stored.message, undefined, "the failure message is cleared");
  assert.equal(compiles().length, 1, "a check never writes");
});

test("an unresolved or too-early check keeps the failure and records the verdict", async () => {
  h.setCompile(uncertain);
  const item = await createItem(h, alice, { lang: "0176" });
  h.setReconcile(() => ({ status: 200, body: { status: "success", data: { operations: [{ verdict: "unresolved", records: [{ landed: false, found: true, matches: false }] }] } } }));
  const u = ok(await h.gql(CHECK, { id: item.id }, alice)).reconcileItemWrite.lastWrite;
  assert.equal(u.status, "failed");
  let stored = await storedLastWrite(item.id);
  assert.equal(stored.status, "failed");
  assert.equal(stored.reconcile.verdict, "unresolved");
  assert.match(stored.reconcile.text, /0 of 1 records/);
  h.setReconcile(() => ({ status: 200, body: { status: "success", data: { operations: [{ verdict: "too-early", retryAfter: new Date(Date.now() + 60_000).toISOString() }] } } }));
  const t = ok(await h.gql(CHECK, { id: item.id }, alice)).reconcileItemWrite.lastWrite;
  assert.equal(t.status, "failed");
  stored = await storedLastWrite(item.id);
  assert.equal(stored.reconcile.verdict, "too-early");
});

test("a newer save made during the check wins", async () => {
  h.setCompile(uncertain);
  const item = await createItem(h, alice, { lang: "0176" });
  h.setReconcile(async () => {
    // A newer save lands while the check is in flight.
    await h.db.doc(`users/alice/items/${item.id}`).update({ "lastWrite.idempotencyKey": "save:newer", "lastWrite.at": Date.now() });
    return { status: 200, body: { status: "success", data: { operations: [{ verdict: "applied", final: true }] } } };
  });
  ok(await h.gql(CHECK, { id: item.id }, alice));
  const stored = await storedLastWrite(item.id);
  assert.equal(stored.idempotencyKey, "save:newer");
  assert.equal(stored.status, "failed", "the check's verdict is discarded");
  assert.equal(stored.confirmed, undefined);
});

test("only uncertain or partial saves can be checked", async () => {
  const item = await createItem(h, alice, { lang: "0176" });
  const err = errorOf(await h.gql(CHECK, { id: item.id }, alice));
  assert.match(err.message, /can't be checked/);
});

test("without a connection a connectable item isn't written", async () => {
  h.setConnections([]);
  const item = await createItem(h, alice, { lang: "0176" });
  assert.equal(compiles().length, 0);
  assert.ok(item.lastWrite === null || item.lastWrite.status === "skipped", JSON.stringify(item.lastWrite));
});

test("a non-connectable language never writes through a connection", async () => {
  const item = await createItem(h, alice, { lang: "0175" });
  assert.equal(compiles().length, 0);
  assert.equal(item.lastWrite, null);
  assert.equal(ok(await getItem(h, alice, item.id)).item.lastWrite, null);
});

// --- writes as commands (C6, D3): POST /command, and the compile fallbacks --

const commands = () => h.calls.filter(c => c.method === "POST" && c.path === "/command").map(c => c.body);
const commandAnswer = (outcome: string, commandId = "cmd-1") =>
  ({ status: 200, body: { status: "success", data: { commandId, outcome, result: outcome === "completed" ? "available" : "none", statusUrl: `/command/${commandId}` }, error: null } });
const refusedWith = (status: number, reason: string) =>
  ({ status, body: { status: "error", error: { code: status, message: "command refused", reason }, data: null } });

test("a save is a command with the save's key, and nothing compiles", async () => {
  h.setCommand(({ method }) => method === "POST" ? commandAnswer("completed") : refusedWith(404, "not-found"));
  const item = await createItem(h, alice, { lang: "0176" });
  assert.deepEqual(commands(), [{ id: item.taskId, data: {}, connectionId: "conn-1", idempotencyKey: saveKey(item.id, item.taskId) }]);
  assert.deepEqual(compiles(), []);
  assert.equal(item.lastWrite.status, "ok");
  assert.equal((await storedLastWrite(item.id)).idempotencyKey, saveKey(item.id, item.taskId));
});

test("a partial or uncertain command is a checkable failure, checked by its key", async () => {
  for (const outcome of ["partial", "uncertain"]) {
    h.setCommand(() => commandAnswer(outcome));
    const item = await createItem(h, alice, { lang: "0176" });
    assert.equal(item.lastWrite.status, "failed");
    assert.match(item.lastWrite.message, new RegExp(`the command is ${outcome}, read it at /command/cmd-1`));
    assert.equal(item.lastWrite.checkable, true);
    h.setReconcile(({ idempotencyKey }) => {
      assert.equal(idempotencyKey, saveKey(item.id, item.taskId));
      return { status: 200, body: { status: "success", data: { operations: [{ verdict: "applied", final: true }] } } };
    });
    const w = ok(await h.gql(CHECK, { id: item.id }, alice)).reconcileItemWrite.lastWrite;
    assert.equal(w.status, "ok");
    assert.equal(w.confirmed, true);
  }
  assert.deepEqual(compiles(), []);
});

test("a failed command is a failure that isn't checkable", async () => {
  h.setCommand(() => commandAnswer("failed"));
  const item = await createItem(h, alice, { lang: "0176" });
  assert.equal(item.lastWrite.status, "failed");
  assert.match(item.lastWrite.message, /the command is failed/);
  assert.equal(item.lastWrite.checkable, false);
});

test("a refused command records the refusal's reason, and nothing compiles", async () => {
  h.setCommand(() => refusedWith(403, "system-connection"));
  const item = await createItem(h, alice, { lang: "0176" });
  assert.equal(item.lastWrite.status, "failed");
  assert.match(item.lastWrite.message, /permission denied \(system-connection\)/);
  assert.deepEqual(compiles(), []);
});

test("a chain the api says isn't a command compiles through the connection with the same key", async () => {
  for (const reason of ["no-effects", "commands-not-enabled"]) {
    await h.resetFirestore();
    h.enablePolicy();
    h.setConnections([{ connectionId: "conn-1", backend: "learnosity", status: "active", label: "Item bank", ownerPermissions: null }]);
    h.setCommand(() => refusedWith(409, reason));
    const item = await createItem(h, alice, { lang: "0176" });
    assert.equal(commands().length, 1);
    assert.deepEqual(compiles(), [{ id: item.taskId, data: {}, connectionId: "conn-1", idempotencyKey: saveKey(item.id, item.taskId) }]);
    assert.equal(item.lastWrite.status, "ok");
  }
});

test("a key the legacy path holds compiles with that key, and reports the compile's outcome", async () => {
  h.setCommand(() => ({ status: 200, body: { status: "success", data: { protocol: "legacy", invocationId: "inv-1", outcome: "failed", result: "unavailable" }, error: null } }));
  h.setCompile(uncertain);
  const item = await createItem(h, alice, { lang: "0176" });
  const [compiled] = compiles();
  assert.equal(compiled.idempotencyKey, commands()[0].idempotencyKey);
  assert.match(item.lastWrite.message, /the save is uncertain/, "the compile's own message, not the command answer's");
});

test("a pending command is read at its status URL until it settles", async () => {
  let reads = 0;
  h.setCommand(({ method, id }) => {
    if (method === "POST") return commandAnswer("pending", "cmd-p");
    assert.equal(id, "cmd-p");
    reads += 1;
    return commandAnswer(reads < 2 ? "pending" : "completed", "cmd-p");
  });
  const item = await createItem(h, alice, { lang: "0176" });
  assert.equal(reads, 2);
  assert.equal(item.lastWrite.status, "ok");
  assert.deepEqual(compiles(), []);
});

test("as commands, retry replays the save's key and recompile uses a fresh one", async () => {
  h.setCommand(() => commandAnswer("uncertain"));
  const item = await createItem(h, alice, { lang: "0176" });
  ok(await h.gql(`mutation($id:String!){ retryItemWrite(id:$id){ id } }`, { id: item.id }, alice));
  const [first, retry] = commands();
  assert.equal(retry.idempotencyKey, first.idempotencyKey);
  h.setCommand(() => commandAnswer("completed", "cmd-2"));
  const r = ok(await h.gql(`mutation($id:String!){ recompileItem(id:$id){ lastWrite { status } } }`, { id: item.id }, alice)).recompileItem;
  assert.match(commands().at(-1).idempotencyKey, /^recompile:[0-9a-f-]{36}$/);
  assert.equal(r.lastWrite.status, "ok");
  assert.deepEqual(compiles(), []);
});
