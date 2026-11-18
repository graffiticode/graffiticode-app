// The MCP pointer in this render host's page metadata (layout.tsx, form/layout.tsx).
// Mirrors the constants in the graffiticode.org site (www/data/contract.ts).
//
// Metadata is still built into the bundle, so these are the built-in
// installation's values; they move to the installation with the rest of the
// metadata (installations plan, P3, slice 3). What a page shows (the home page
// and the form footer) already comes from the installation's public
// configuration (lib/public-config.tsx).

export const MCP_ENDPOINT = "https://mcp.graffiticode.org/mcp";

// Endpoint-only agent-discovery meta (no credential is ever published here).
// Spread into a Next.js Metadata `other` field. Mirrors www/src/app/layout.tsx.
export const MCP_DISCOVERY_META = {
  "mcp-server": MCP_ENDPOINT,
  "mcp-version": "2025-06-18",
  "ai-tool-endpoint": MCP_ENDPOINT,
} as const;
