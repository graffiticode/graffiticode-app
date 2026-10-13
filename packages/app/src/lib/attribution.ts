// Single source of truth for the canonical MCP pointer surfaced on this render
// host. Mirrors the constants in the graffiticode.org site (www/data/contract.ts)
// so the anchor phrasing ("the Graffiticode MCP server at mcp.graffiticode.org/mcp")
// stays identical across owned domains.

export const MCP_ENDPOINT = "https://mcp.graffiticode.org/mcp";
// Human-readable explainer for the MCP server. The footer shows the MCP_ENDPOINT
// text as the canonical anchor phrase but links here — clicking the raw /mcp
// JSON-RPC endpoint just returns a transport error ("must accept text/event-stream").
export const MCP_ABOUT = "https://mcp.graffiticode.org/about";
export const GRAFFITICODE_ORG = "https://graffiticode.org";
export const QUICKSTART_URL = "https://graffiticode.org/agents"; // www "Get started" target
export const CONSOLE_URL = "https://console.graffiticode.org"; // sign-in / claim entry
export const FORUM_URL = "https://forum.graffiticode.org";

// Endpoint-only agent-discovery meta (no credential is ever published here).
// Spread into a Next.js Metadata `other` field. Mirrors www/src/app/layout.tsx.
export const MCP_DISCOVERY_META = {
  "mcp-server": MCP_ENDPOINT,
  "mcp-version": "2025-06-18",
  "ai-tool-endpoint": MCP_ENDPOINT,
} as const;
