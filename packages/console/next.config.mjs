// CSP policy used in report-only mode so we surface violations without
// breaking existing third parties (Firebase, Stripe, Google fonts, etc.).
// Privy origins are listed here so the email magic-link flow works once
// enforcement is enabled in a follow-up.
const cspDirectives = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.stripe.com https://*.firebaseio.com https://*.googleapis.com https://apis.google.com https://*.privy.io https://auth.privy.io",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https: https://*.privy.io",
  "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com https://*.stripe.com https://api.graffiticode.org https://auth.graffiticode.org https://*.privy.io https://auth.privy.io wss://*.privy.io https://api.openai.com https://api.anthropic.com",
  "frame-src 'self' https://*.stripe.com https://*.privy.io https://auth.privy.io",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

/** @type {import("next").NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // @graffiticode/auth-react ships raw TS (main → src/index.ts), so Next must
  // transpile it like first-party code.
  transpilePackages: ["@graffiticode/auth-react"],
  async rewrites() {
    return [{
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
    }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy-Report-Only', value: cspDirectives },
        ],
      },
    ];
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
  // Make environment variables available to the client
  env: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  },
};

export default nextConfig;
