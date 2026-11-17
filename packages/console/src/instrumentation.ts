// Server startup (Next runs register() once, before serving any request).
// Loads and validates the installation profile (PROFILE_DIR), so an invalid
// profile, or a host that contradicts it, stops the server instead of the
// first request. Node only: the edge runtime has no file system.
// Installations plan, P2, console loading.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureInstallation } = await import("@graffiticode-app/core/profile/runtime");
  try {
    const receipt = ensureInstallation();
    if (receipt) console.log(`[installation] ${JSON.stringify(receipt)}`);
  } catch (err) {
    console.error(`[installation] ${(err as Error).message}`);
    // Don't serve with a profile that didn't load.
    process.exit(1);
  }
}
