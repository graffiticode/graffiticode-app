// The tool families this release can serve (installations plan, P2,
// discovery). A profile selects families for its MCP surfaces; whether a
// family has handlers is a fact of the release, declared here, never by a
// profile. Discovery advertises only available families, and their tools in
// this order. The MCP server's served catalog is tested against it
// (mcp-server/tests/surfaces.test.ts).

export type SurfaceFamily = "items" | "services";

// `path` is where this release serves the family: fixed for the item tools,
// so a profile must select them at exactly that path; null for the service
// tools, which a profile serves at a path of its own (but not the item path:
// one endpoint, one OAuth resource, until plan P5/P6). `tools` are the
// family's fixed tools (the service family's others are generated from the
// profile, service-catalog.ts). `inDiscoveryFiles`: the generated discovery
// files describe this family's endpoint (profile/discovery-files.ts).
export const SURFACE_FAMILIES: Record<SurfaceFamily, { available: boolean; tools: readonly string[]; path: string | null; inDiscoveryFiles: boolean }> = {
  // The generic item tools (mcp-server/src/tools.ts).
  items: {
    available: true,
    tools: ["create_item", "update_item", "get_item", "render_item", "get_spec", "list_languages", "get_language_info"],
    path: "/mcp",
    inDiscoveryFiles: true,
  },
  // Tools generated from a profile's services (plan P4; mcp-server/src/service-tools.ts),
  // with the shared job tools.
  services: { available: true, tools: ["job_get", "job_cancel"], path: null, inDiscoveryFiles: false },
};

// Paths the MCP server answers itself (mcp-server/src/server.ts), which a
// profile's surface can't claim: it would be shadowed, or would shadow a
// page, a discovery file or the OAuth flow. Exact paths, and prefixes for the
// trees under them. mcp-server/tests/surfaces.test.ts checks every route the
// server matches is listed here.
export const RESERVED_MCP_PATHS: readonly string[] = [
  "/", "/about", "/privacy", "/terms", "/robots.txt", "/favicon.ico", "/health", "/mcp.json",
];
export const RESERVED_MCP_PREFIXES: readonly string[] = ["/.well-known/", "/oauth/", "/widget/"];

export const isReservedMcpPath = (path: string) =>
  RESERVED_MCP_PATHS.includes(path) || RESERVED_MCP_PREFIXES.some(p => path === p.slice(0, -1) || path.startsWith(p));
