import type { Metadata } from "next";
import { ensureInstallation, installationHosts } from "@graffiticode-app/core/profile/runtime";
import { buildPublicConfig } from "@graffiticode-app/core/profile/public-config-server";

// Item pages render per request anyway (a dynamic segment), so their metadata
// is the installation's own, in the HTML itself: the title and description,
// and the MCP discovery tags agents read from a page (installations plan, P3,
// slice 3). Every other page keeps the build's defaults in its HTML.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  ensureInstallation();
  const { metadata } = buildPublicConfig();
  const endpoint = installationHosts().mcpResource;
  return {
    title: metadata.app.title,
    description: metadata.app.description,
    other: { "mcp-server": endpoint, "mcp-version": "2025-06-18", "ai-tool-endpoint": endpoint },
  };
}

export default function FormItemLayout({ children }: { children: React.ReactNode }) {
  return children;
}
