import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { MCP_ENDPOINT } from "@/lib/attribution";

export const metadata: Metadata = {
  title: "Graffiticode",
  description: `Render Graffiticode items and tasks as forms — created via the Graffiticode MCP server at ${MCP_ENDPOINT.replace(/^https?:\/\//, "")}`,
  // Machine-readable pointer to the canonical entry for DOM-scraping agents
  // (see agent-oriented-marketing-primer.md § Funneling across owned domains).
  other: { "mcp-server": MCP_ENDPOINT },
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
