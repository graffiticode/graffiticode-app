// The MCP suite again, with MCP calling @graffiticode-app/core in-process
// (GRAFFITICODE_BACKEND=core) instead of the console's GraphQL endpoint.
process.env.GRAFFITICODE_BACKEND = "core";
await import("./mcp.test.ts");
