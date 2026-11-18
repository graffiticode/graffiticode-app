// Server startup (Next runs register() once, before serving any request).
// Loads and validates the installation profile (PROFILE_DIR), so an invalid
// profile, a host that contradicts it, or an image that can't be served stops
// the server instead of the first request, and publishes the security headers
// the middleware sets (installations plan, P3, slice 3).
//
// The Node-only work lives in instrumentation-node.ts, imported only under
// NEXT_RUNTIME === "nodejs": Next also compiles this file for the edge runtime
// (the middleware's), and that branch is removed from the edge build.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startInstallation } = await import("./instrumentation-node");
    startInstallation();
  }
}
