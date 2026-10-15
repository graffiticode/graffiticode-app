// Languages with protected functions in the policy registry
// (graffiticode packages/common/src/protected-registry.js), and the backend
// each one's connection is for. Only these items write through a connection.
// Shared by the browser and the server, so it imports nothing.
export const CONNECTABLE_LANGS: Record<string, string> = {
  "0176": "learnosity",
};

// "L176", "176" and "0176" all name the same language.
export const normalizeLang = (lang: unknown) =>
  String(lang ?? "").replace(/^L/i, "").padStart(4, "0");

export const isConnectableLang = (lang: unknown) =>
  Object.prototype.hasOwnProperty.call(CONNECTABLE_LANGS, normalizeLang(lang));

export const backendForLang = (lang: unknown): string | null =>
  isConnectableLang(lang) ? CONNECTABLE_LANGS[normalizeLang(lang)] : null;

// The connection to view a version through: only one it was actually written
// through. A view through a connection reads the stored result and never runs
// the program, so asking for a version that has none (saved before saves wrote,
// a failed write, an unsaved edit) is an error. Those preview normally instead.
export const viewConnectionId = (
  item: { connectionId?: string | null; lastWrite?: { taskId?: string; connectionId?: string | null; status?: string } | null } | null | undefined,
  taskId: string | null | undefined,
): string | null => {
  const connectionId = item?.connectionId ?? null;
  const write = item?.lastWrite;
  return connectionId && taskId && write?.status === "ok" && write.taskId === taskId && write.connectionId === connectionId
    ? connectionId
    : null;
};

// Whether a program (its parsed code as stored on the item: the parser's node
// pool, `{ "1": { tag, elts }, …, root }`) asks to write to the item bank.
// L0176 marks it with a SAVE_TO_ITEMBANK node, in either the explicit form
// (`save-to-itembank items [...] {}`) or the legacy member
// (`items [save-to-itembank true, …] {}`); a literal `save-to-itembank false`
// does not write. Walks the whole value, so a nested or differently keyed
// shape still answers; anything unrecognizable answers false.
export const programSavesToItemBank = (code: unknown): boolean => {
  if (!code || typeof code !== "object") return false;
  const pool = code as Record<string, any>;
  const seen = new Set<unknown>();
  const isFalseLiteral = (arg: unknown) => {
    const node = (typeof arg === "number" || typeof arg === "string") ? pool[arg] : arg;
    return node?.tag === "BOOL" && node.elts?.[0] === false;
  };
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    const node = value as Record<string, any>;
    if ((node.tag === "SAVE_TO_ITEMBANK" || node.tag === "save-to-itembank" || node.lexeme === "save-to-itembank") &&
        !isFalseLiteral(node.elts?.[0])) {
      return true;
    }
    return Object.values(node).some(visit);
  };
  return visit(pool);
};
