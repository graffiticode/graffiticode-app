"use client";

// The document's title and description in the browser (installations plan,
// P3, slice 3): one owner. The prerendered HTML carries the build's defaults
// (app/layout.tsx); once the installation's configuration has loaded, this
// sets its title and description (metadata.app), and sets them again after
// each client-side navigation. It updates the document's one description in
// place, so there is never a second.
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { usePublicConfig } from "./public-config";

export function DocumentMetadata() {
  const { metadata } = usePublicConfig();
  const pathname = usePathname();
  useEffect(() => {
    const { title, description } = metadata.app;
    document.title = title;
    let meta = document.head.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "description";
      document.head.appendChild(meta);
    }
    meta.content = description;
  }, [metadata, pathname]);
  return null;
}
