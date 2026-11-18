"use client";

import Link from "next/link";
import { AuthLink } from "@/components/AuthLink";
import { usePublicConfig } from "@/lib/public-config";

const bare = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

// The installation's render host. Its name, MCP endpoint and links come from
// its public configuration (rendered in the browser, under ConfigGate, so a
// build carries no installation's values).
export default function HomePage() {
  const { brand, mcp } = usePublicConfig();
  const { product, forum } = brand.links;
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-semibold">{brand.name}</h1>
      <p className="max-w-md text-gray-600">
        This is where {brand.name} artifacts are rendered. Open one at{" "}
        <code className="rounded bg-gray-100 px-1.5 py-0.5">/form/&lt;id&gt;</code>, where{" "}
        <code className="rounded bg-gray-100 px-1.5 py-0.5">&lt;id&gt;</code> is a task or item id.
      </p>
      <p className="max-w-md text-gray-600">
        Made with {brand.name}. Agents create and update these artifacts through the
        {" "}{brand.name} MCP server at{" "}
        <a href={mcp.endpoint} className="text-blue-600 underline">
          {bare(mcp.endpoint)}
        </a>
        .{product && (
          <>
            {" "}Learn more at{" "}
            <a href={product} className="text-blue-600 underline">
              {bare(product)}
            </a>
            {forum ? " or the " : ""}
          </>
        )}
        {forum && (
          <>
            {product ? "" : " Ask in the "}
            <a href={forum} className="text-blue-600 underline">
              community forum
            </a>
          </>
        )}
        {product || forum ? "." : ""}
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
