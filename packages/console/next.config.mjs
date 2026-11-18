import { fileURLToPath } from "node:url";

// The Content-Security-Policy (report-only) is set per response by
// src/middleware.ts from the installation the server runs as
// (core/src/profile/security-headers.ts), no longer here at build time.

/** @type {import("next").NextConfig} */
const nextConfig = {
  output: "standalone",
  // Trace from the monorepo root: dependencies are hoisted to the root
  // node_modules, so tracing from this package alone would leave them out of
  // .next/standalone. The server then lands at standalone/packages/console/.
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  reactStrictMode: true,
  // @graffiticode/auth-react ships raw TS (main → src/index.ts), so Next must
  // transpile it like first-party code.
  transpilePackages: ["@graffiticode/auth-react"],
  async rewrites() {
    // The brand images keep their fixed URLs, so the prerendered HTML is the
    // same for every installation; the server answers each with the
    // installation's image, or this build's file without a profile
    // (pages/api/brand-image/[name].ts). beforeFiles: ahead of public/.
    const beforeFiles = ["favicon.png", "logo.png"].map(name => ({
      source: `/${name}`,
      destination: `/api/brand-image/${name}`,
    }));
    return { beforeFiles, afterFiles: [{
      source: "/docs",
      destination: "https://docs.graffiticode.com",
    }, {
      // Funnel report links land here. Served by an API route (not a page) so it
      // bypasses _app.tsx's AuthWrapper — the signed token is the credential and
      // the link has to open from an SMS with no sign-in. Short path because
      // every character competes with the digest text in a 160-char segment.
      source: "/r/:token",
      destination: "/api/r/:token",
    }, {
      // Corpus sweep reports. Same reasoning as /r/ above — no sign-in, short path.
      source: "/s/:token",
      destination: "/api/s/:token",
    }], fallback: [] };
  },
  webpack: (config) => {
    config.experiments = { ...config.experiments, ...{ topLevelAwait: true } };
    return config;
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'cdn.acx.ac',
        pathname: '**',
      },
      {
        protocol: 'https',
        hostname: 'firebasestorage.googleapis.com',
        pathname: '**',
      },
    ],
  },
  // No `env` block: it inlined ANTHROPIC_API_KEY into the client bundle when the key was present at build
  // time. Every reader is server-side and reads process.env at runtime.
};

export default nextConfig;
