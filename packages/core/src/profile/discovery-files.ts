// Discovery files for an installation (installations plan, P2, discovery):
// the app site's llms.txt and .well-known/mcp.json, and the agent-app
// listing's plugin.meta.json. One generator, from the validated profile and
// what this release actually serves:
//   - the MCP endpoint and item tools come from derivedVariables() and the
//     surface registry, so the three files can't disagree on them;
//   - a family whose handlers this release doesn't have is advertised nowhere,
//     and reported as omitted;
//   - copy that names a vendor the installation doesn't offer is refused.
// Structure is code; prose is the profile's copy. Pure: the caller loads the
// profile and writes the files (cli.ts discovery).
import type { Profile } from "./schema.js";
import { derivedVariables } from "./template.js";
import { SURFACE_FAMILIES, type SurfaceFamily } from "../surfaces.js";
import { unavailableBrandsNamed } from "../lib/languages.js";
import type { InstalledProfile } from "./current.js";

export type DiscoveryInput = {
  profile: Profile;
  // The installation whose catalog policy the vendor checks use. Passed in,
  // never read from the process, so generations for different installations
  // can run at once.
  installed: InstalledProfile;
  // A rendered copy template, or null when the profile has none.
  copy: (key: string) => string | null;
  // A profile file's bytes (the listing icon).
  readFile: (relativePath: string) => Uint8Array;
};

export type DiscoveryOutput = {
  files: Record<string, string | Uint8Array>;
  advertisedFamilies: SurfaceFamily[];
  omittedFamilies: { family: SurfaceFamily; reason: string }[];
  problems: string[];
};

const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

export function generateDiscoveryFiles({ profile: p, installed, copy, readFile }: DiscoveryInput): DiscoveryOutput {
  const problems: string[] = [];
  const need = (key: string) => {
    const text = copy(key);
    if (text === null) problems.push(`copy ${key} is required`);
    return text ?? "";
  };
  const checkVendors = (key: string, text: string) => {
    const unavailable = unavailableBrandsNamed(text, installed);
    if (unavailable.length) problems.push(`copy ${key} names ${unavailable.join(", ")}, which this installation doesn't offer`);
  };

  const selected = [...new Set(p.surfaces.mcp.flatMap(m => m.families))] as SurfaceFamily[];
  const advertisedFamilies = selected.filter(f => SURFACE_FAMILIES[f].available && SURFACE_FAMILIES[f].inDiscoveryFiles);
  const omittedFamilies = selected.filter(f => !advertisedFamilies.includes(f)).map(family => ({
    family,
    reason: !SURFACE_FAMILIES[family].available
      ? "no handlers in this release"
      : `served at ${p.surfaces.mcp.filter(m => m.families.includes(family)).map(m => m.path).join(", ")}; these files describe the item endpoint only`,
  }));
  const derived = derivedVariables(p);
  const endpoint = derived["discovery.mcpEndpoint"];
  if (!endpoint) problems.push("no available MCP family is selected; there is no endpoint to advertise");
  const tools = advertisedFamilies.flatMap(f => SURFACE_FAMILIES[f].tools);

  const files: Record<string, string | Uint8Array> = {};

  // The app site.
  const llms = need("discovery.llms");
  checkVendors("discovery.llms", llms);
  files["app/llms.txt"] = llms + "\n";
  const description = need("discovery.app.description");
  checkVendors("discovery.app.description", description);
  files["app/.well-known/mcp.json"] = json({
    mcp_endpoint: endpoint,
    site: p.hosts.app,
    description,
    tools,
    product_url: p.brand.links?.product,
    console_url: p.hosts.console,
    forum_url: p.brand.links?.forum,
    github_url: p.brand.links?.source,
  });

  // The agent-app listing, when the installation has one.
  if (p.listing) {
    const l = p.listing;
    const longDescription = need("listing.longDescription");
    const prompts = need("listing.defaultPrompts").split("\n").filter(Boolean);
    checkVendors("listing.longDescription", longDescription);
    checkVendors("listing.defaultPrompts", prompts.join("\n"));
    if (!p.brand.assets.icon) problems.push("brand.assets.icon is required for a listing");
    files["skills/plugin.meta.json"] = json({
      name: l.pluginName,
      author: { name: l.author.name, url: l.author.url },
      interface: {
        displayName: l.displayName,
        shortDescription: l.shortDescription,
        category: l.category,
        longDescription,
        defaultPrompt: prompts,
        websiteURL: p.brand.links?.product,
        supportURL: l.supportUrl,
        // The MCP server serves the installation's legal documents.
        privacyPolicyURL: `${p.hosts.mcp}/privacy`,
        termsOfServiceURL: `${p.hosts.mcp}/terms`,
        composerIcon: "./assets/icon.png",
        logo: "./assets/icon.png",
      },
      mcpServers: { [p.installation.id]: { type: "streamable-http", url: endpoint } },
    });
    if (p.brand.assets.icon) files["skills/assets/icon.png"] = readFile(p.brand.assets.icon);
  }
  return { files, advertisedFamilies, omittedFamilies, problems };
}
