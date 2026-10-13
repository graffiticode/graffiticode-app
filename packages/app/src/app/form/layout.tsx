import type { Metadata } from "next";
import { FormFooter } from "@/components/FormFooter";
import { MCP_DISCOVERY_META } from "@/lib/attribution";

// Per-item artifact pages (/form and /form/<id>) should not be search-indexed —
// they render user-created items, not funnel/landing content. The host root (/)
// stays indexable so it remains a discoverable high-signal entry point. They do
// carry endpoint-only MCP discovery meta so DOM-scraping agents can find the
// canonical server even though the page is noindex for human-search crawlers.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  other: { ...MCP_DISCOVERY_META },
};

// Column layout so the attribution footer pins below a flex-1 content area. The
// children (FormHarness iframe, sign-in / not-found states) fill the content
// area instead of the full viewport, leaving room for the footer on every state.
export default function FormLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen flex-col">
      <div className="min-h-0 flex-1">{children}</div>
      <FormFooter />
    </div>
  );
}
