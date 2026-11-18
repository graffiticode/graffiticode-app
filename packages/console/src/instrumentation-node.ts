// The console server's startup, in Node (see instrumentation.ts).
import { ensureInstallation, publishSecurityHeaders } from "@graffiticode-app/core/profile/runtime";

export function startInstallation() {
  try {
    const receipt = ensureInstallation();
    if (receipt) console.log(`[installation] ${JSON.stringify(receipt)}`);
    // Computed once from the pinned installation; the middleware reads them.
    publishSecurityHeaders("console");
  } catch (err) {
    console.error(`[installation] ${(err as Error).message}`);
    // Don't serve with a profile that didn't load.
    process.exit(1);
  }
}
