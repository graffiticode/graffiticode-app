// The tool families this release can serve (installations plan, P2,
// discovery). A profile selects families for its MCP surfaces; whether a
// family has handlers is a fact of the release, declared here, never by a
// profile. Discovery advertises only available families, and their tools in
// this order. The MCP server's served catalog is tested against it
// (mcp-server/tests/surfaces.test.ts).

export type SurfaceFamily = "items" | "services";

// `path` is where this release serves the family. MCP routing isn't
// configurable yet, so a profile must select an available family at exactly
// that path (profile/validate.ts).
export const SURFACE_FAMILIES: Record<SurfaceFamily, { available: boolean; tools: readonly string[]; path: string | null }> = {
  // The generic item tools (mcp-server/src/tools.ts).
  items: {
    available: true,
    tools: ["create_item", "update_item", "get_item", "render_item", "get_spec", "list_languages", "get_language_info"],
    path: "/mcp",
  },
  // Tools generated from a profile's services (plan P4); no handlers yet.
  services: { available: false, tools: [], path: null },
};
