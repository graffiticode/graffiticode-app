// node:test via tsx: `npm test`.
import test from "node:test";
import assert from "node:assert/strict";
import { CallerRefused, DEFAULT_AUDIENCE, DEFAULT_CALLERS, firestoreItems, itemAuthorityAnswer, parseCallers, verifyCaller, type ItemRecord } from "./item-authority";

const POLICY = "policy-run@graffiticode.iam.gserviceaccount.com";
const verified = (payload: Record<string, unknown>) => async () => payload as any;
const token = (over: Record<string, unknown> = {}) => ({ iss: "https://accounts.google.com", email: POLICY, email_verified: true, aud: DEFAULT_AUDIENCE, ...over });
const ask = (authorization: string | undefined, payload: Record<string, unknown> | Error) =>
  verifyCaller({
    authorization,
    audience: DEFAULT_AUDIENCE,
    callers: DEFAULT_CALLERS,
    verifyIdToken: payload instanceof Error ? async () => { throw payload; } : verified(payload),
  });

test("accepts only policy-run's verified Google ID token for this route's audience", async () => {
  assert.equal(await ask("Bearer t", token()), POLICY);
  for (const [authorization, payload] of [
    [undefined, token()],
    ["Basic t", token()],
    ["Bearer t", new Error("bad signature")],
    ["Bearer t", token({ email: "console-run@graffiticode-app.iam.gserviceaccount.com" })],
    ["Bearer t", token({ email: "someone@example.com" })],
    ["Bearer t", token({ email_verified: false })],
    ["Bearer t", token({ iss: "https://evil.example" })],
    ["Bearer t", token({ aud: "https://console.graffiticode.org/api/other" })],
  ] as const) {
    await assert.rejects(ask(authorization, payload as any), CallerRefused);
  }
});

test("passes the route's own audience to verification", async () => {
  let asked;
  await verifyCaller({ authorization: "Bearer t", audience: DEFAULT_AUDIENCE, callers: DEFAULT_CALLERS, verifyIdToken: async args => { asked = args; return token(); } });
  assert.deepEqual(asked, { idToken: "t", audience: DEFAULT_AUDIENCE });
});

test("allows only the configured callers, Policy's own by default", () => {
  assert.deepEqual(parseCallers(undefined), [POLICY]);
  assert.deepEqual(parseCallers(" a@x.iam.gserviceaccount.com , b@x.iam.gserviceaccount.com "), ["a@x.iam.gserviceaccount.com", "b@x.iam.gserviceaccount.com"]);
});

const answerFor = (records: ItemRecord[]) => itemAuthorityAnswer({ itemId: "item-1", findItems: async () => records });
const record = (over: Partial<ItemRecord> = {}): ItemRecord => ({ ownerUid: "uid-1", isPublic: false, taskId: "task-1", lang: "0002", ...over });

test("answers an unknown item exists: false", async () => {
  assert.deepEqual(await answerFor([]), { exists: false });
});

test("answers an item under two owners ambiguous", async () => {
  assert.deepEqual(await answerFor([record(), record({ ownerUid: "uid-2" })]), { ambiguous: true });
  assert.deepEqual(await answerFor([record(), record()]), { ambiguous: true });
});

test("answers one item's owner, publicity, task and language, and nothing else", async () => {
  assert.deepEqual(await answerFor([record()]), { exists: true, ownerUid: "uid-1", isPublic: false, taskId: "task-1", lang: "0002" });
  assert.deepEqual(await answerFor([record({ isPublic: true, taskId: null, lang: null })]), { exists: true, ownerUid: "uid-1", isPublic: true, taskId: null, lang: null });
  assert.deepEqual(await answerFor([record({ ownerUid: null })]), { exists: false });
});

test("reads the store by a collection-group query on id, at most two, under any owner", async () => {
  const asked: unknown[] = [];
  const doc = (id: string, owner: string, data: Record<string, unknown>) => ({ id, ref: { parent: { parent: { id: owner } } }, data: () => data });
  const db = {
    collectionGroup: (name: string) => ({
      where: (field: string, op: string, value: string) => ({
        limit: (n: number) => ({
          get: async () => {
            asked.push([name, field, op, value, n]);
            return { docs: [doc("item-1", "uid-1", { id: "item-1", isPublic: true, taskId: "t", lang: "0013", name: "secret name" }), doc("other", "uid-2", { id: "item-1" })] };
          },
        }),
      }),
    }),
  };
  const found = await firestoreItems(db)("item-1");
  assert.deepEqual(asked, [["items", "id", "==", "item-1", 2]]);
  // Nothing is dropped: a doc whose own id isn't the item's is marked.
  assert.deepEqual(found, [
    { ownerUid: "uid-1", isPublic: true, taskId: "t", lang: "0013", consistent: true },
    { ownerUid: "uid-2", isPublic: false, taskId: null, lang: null, consistent: false },
  ]);
});

// The owner's review of app#116: the query's limit comes before any
// filtering, so an inconsistent record can hide a third. Any inconsistent
// record answers ambiguous; only exactly one consistent record is an answer.
test("answers ambiguous when any match is inconsistent, whatever the query's limit hid", async () => {
  // An inconsistent record first, a public duplicate second; the private
  // owner's record would be third, past the limit.
  const docs = [
    { id: "not-item-1", ref: { parent: { parent: { id: "uid-9" } } }, data: () => ({ id: "item-1", isPublic: false }) },
    { id: "item-1", ref: { parent: { parent: { id: "uid-2" } } }, data: () => ({ id: "item-1", isPublic: true }) },
    { id: "item-1", ref: { parent: { parent: { id: "uid-1" } } }, data: () => ({ id: "item-1", isPublic: false }) },
  ];
  const db = { collectionGroup: () => ({ where: () => ({ limit: (n: number) => ({ get: async () => ({ docs: docs.slice(0, n) }) }) }) }) };
  assert.deepEqual(await itemAuthorityAnswer({ itemId: "item-1", findItems: firestoreItems(db) }), { ambiguous: true });
  assert.deepEqual(await answerFor([record({ consistent: false })]), { ambiguous: true });
  // Exactly one consistent record is the answer.
  const single = { collectionGroup: () => ({ where: () => ({ limit: (n: number) => ({ get: async () => ({ docs: docs.slice(2, 2 + n) }) }) }) }) };
  assert.deepEqual(await itemAuthorityAnswer({ itemId: "item-1", findItems: firestoreItems(single) }), { exists: true, ownerUid: "uid-1", isPublic: false, taskId: null, lang: null });
});
