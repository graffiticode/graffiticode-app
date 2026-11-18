const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  // Trace from the monorepo root so the sibling packages/auth-react (a file:
  // dependency) lands in .next/standalone; the server is then at
  // standalone/packages/app/. app has its own install (packages/app/
  // node_modules), so the root node_modules is not involved.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  transpilePackages: ["@graffiticode/auth-react"],
  // The brand image keeps its fixed URL, so the prerendered HTML is the same
  // for every installation; the server answers it with the installation's
  // image, or this build's public/icon.png without a profile
  // (src/app/api/brand-image/[name]/route.ts). beforeFiles: ahead of public/.
  async rewrites() {
    return {
      beforeFiles: [{ source: "/icon.png", destination: "/api/brand-image/icon.png" }],
      afterFiles: [],
      fallback: [],
    };
  },
  // auth-react is a file: dependency symlinked into this package's
  // node_modules. Resolve its imports from that symlinked path (this app's
  // install), not from its real location next to the repo root's
  // node_modules, which belongs to the console. tsconfig sets
  // preserveSymlinks for the same reason.
  webpack(config) {
    config.resolve.symlinks = false;
    return config;
  },
};

module.exports = nextConfig;
