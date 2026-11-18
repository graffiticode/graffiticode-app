import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { MCP_ENDPOINT } from "@/lib/attribution";

// The build's defaults, the same for every installation in the prerendered
// HTML; the installation's title and description follow once its
// configuration loads (lib/document-metadata.tsx). Item pages, which render
// per request anyway, carry the installation's own (form/[id]/layout.tsx).
export const metadata: Metadata = {
  title: "Graffiticode",
  description: `Render Graffiticode items and tasks as forms — created via the Graffiticode MCP server at ${MCP_ENDPOINT.replace(/^https?:\/\//, "")}`,
  // Machine-readable pointer to the canonical entry for DOM-scraping agents
  // (see agent-oriented-marketing-primer.md § Funneling across owned domains).
  other: { "mcp-server": MCP_ENDPOINT },
  // A fixed URL, answered with the installation's image (next.config.js).
  icons: { icon: { url: "/icon.png", type: "image/png" } },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
