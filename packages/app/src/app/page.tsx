import Link from "next/link";
import { AuthLink } from "@/components/AuthLink";

export default function HomePage() {
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-semibold">Graffiticode</h1>
      <p className="max-w-md text-gray-600">
        This is where Graffiticode artifacts are rendered. Open one at{" "}
        <code className="rounded bg-gray-100 px-1.5 py-0.5">/form/&lt;id&gt;</code>, where{" "}
        <code className="rounded bg-gray-100 px-1.5 py-0.5">&lt;id&gt;</code> is a task or item id.
      </p>
      <p className="max-w-md text-gray-600">
        Made with Graffiticode. Agents create and update these artifacts through the
        Graffiticode MCP server at{" "}
        <a href="https://mcp.graffiticode.org/mcp" className="text-blue-600 underline">
          mcp.graffiticode.org/mcp
        </a>
        . Learn more at{" "}
        <a href="https://graffiticode.org" className="text-blue-600 underline">
          graffiticode.org
        </a>{" "}
        or the{" "}
        <a href="https://forum.graffiticode.org" className="text-blue-600 underline">
          community forum
        </a>
        .
      </p>
      <div className="flex flex-wrap items-center justify-center gap-4">
        <Link href="/form" className="text-blue-600 underline">
          Open form view
        </Link>
        <AuthLink className="text-blue-600 underline" />
      </div>
    </main>
  );
}
