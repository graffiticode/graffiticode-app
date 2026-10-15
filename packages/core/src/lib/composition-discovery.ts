type NodePool = Record<string, any>;

export interface ResolveResult {
  upstreams: string[];
  ast: NodePool;
}

// Walks a parsed nodePool for `DATA(USE(STR("<lang>")))` patterns and returns
// the ordered list of upstream language ids found (scan order). The AST is
// returned untouched — the basis runtime fetches each language's schema at
// compile time and validates against it. This keeps the AST simple and lets
// any consumer of api.graffiticode.org validate, not just the console pipeline.
export async function resolveUpstreams(nodePool: NodePool): Promise<ResolveResult> {
  const upstreams: string[] = [];

  for (const nid of Object.keys(nodePool)) {
    if (nid === "root") continue;
    const node = nodePool[nid];
    if (!node || typeof node !== "object" || node.tag !== "DATA") continue;
    const useNid = node.elts?.[0];
    const useNode = useNid != null ? nodePool[useNid] : null;
    if (!useNode || useNode.tag !== "USE") continue;
    const strNid = useNode.elts?.[0];
    const strNode = strNid != null ? nodePool[strNid] : null;
    if (!strNode || strNode.tag !== "STR") continue;
    const lang = String(strNode.elts?.[0] ?? "");
    if (!/^\d{3,5}$/.test(lang)) {
      throw new Error(`Composition error: \`use\` argument must be a language id, got "${lang}"`);
    }
    upstreams.push(lang);
  }

  return { upstreams, ast: nodePool };
}
