// Server startup (Next runs register() once, before serving any request).
// Loads and validates the installation profile (PROFILE_DIR) and the
// installation's storage, so an invalid profile, a host that contradicts it,
// or a missing project stops the server instead of the first request.
// Node only: the edge runtime has no file system. Installations plan, P3,
// slice 1 (part 1b).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureInstallation } = await import("@graffiticode-app/core/profile/runtime");
  try {
    const receipt = ensureInstallation();
    if (receipt) console.log(`[installation] ${JSON.stringify(receipt)}`);
  } catch (err) {
    console.error(`[installation] ${(err as Error).message}`);
    process.exit(1);
  }
}
