const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  // Scope file tracing to this app — the parent dir holds many sibling repos
  // and a node_modules, which Next would otherwise mis-detect as the root.
  outputFileTracingRoot: path.join(__dirname),
  transpilePackages: ["@graffiticode/auth-react"],
};

module.exports = nextConfig;
