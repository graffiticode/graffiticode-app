// The MCP suite in core mode under generation protocol v2 (Phase 3.5 R2): MCP
// reserves v2 jobs in-process and the console's worker runs them.
process.env.GRAFFITICODE_BACKEND = "core";
process.env.GENERATION_PROTOCOL = "v2";
await import("./mcp.test.ts");
