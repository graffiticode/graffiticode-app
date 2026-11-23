/**
 * Firestore stand-in: serialized transactions over a map (as the Admin SDK's
 * runTransaction behaves for these single-document updates), plus the small
 * query surface the reconcile queue uses and `add` for append-only logs.
 */
export function fakeFirestore() {
  const docs = new Map<string, any>();
  const added: Array<{ collection: string; value: any }> = [];
  let queue = Promise.resolve();
  const query = (c: string, filters: Array<[string, string, unknown]>, order: string | null, max: number) => ({
    where: (f: string, op: string, v: unknown) => query(c, [...filters, [f, op, v]], order, max),
    orderBy: (f: string) => query(c, filters, f, max),
    limit: (n: number) => query(c, filters, order, n),
    get: async () => {
      let rows = [...docs.entries()].filter(([k]) => k.startsWith(`${c}/`)).map(([, v]) => structuredClone(v));
      for (const [f, op, v] of filters) {
        rows = rows.filter((r) => (op === '<=' ? r[f] <= (v as any) : op === '==' ? r[f] === v : true));
      }
      if (order) rows.sort((a, b) => a[order] - b[order]);
      return { docs: rows.slice(0, max).map((r) => ({ data: () => r })) };
    },
  });
  return {
    docs,
    added,
    collection: (c: string) => ({
      doc: (id: string) => ({ path: `${c}/${id}` }),
      add: async (value: any) => { added.push({ collection: c, value }); return { id: `added_${added.length}` }; },
      where: (f: string, op: string, v: unknown) => query(c, [[f, op, v]], null, Infinity),
    }),
    runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      const run = queue.then(async () => {
        const writes = new Map<string, any>();
        const tx = {
          get: async (ref: any) => ({ exists: docs.has(ref.path), data: () => structuredClone(docs.get(ref.path)) }),
          set: (ref: any, v: any) => { writes.set(ref.path, structuredClone(v)); },
          delete: (ref: any) => { writes.set(ref.path, undefined); },
        };
        const out = await fn(tx);
        for (const [k, v] of writes) { if (v === undefined) docs.delete(k); else docs.set(k, v); }
        return out;
      });
      queue = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}
