// The app server's startup, in Node (see instrumentation.ts).
import { ensureInstallation, publishSecurityHeaders } from "@graffiticode-app/core/profile/runtime";

export function startInstallation() {
  try {
    const receipt = ensureInstallation();
    if (receipt) console.log(`[installation] ${JSON.stringify(receipt)}`);
    // Computed once from the pinned installation; the middleware reads them.
    publishSecurityHeaders("app");
  } catch (err) {
    console.error(`[installation] ${(err as Error).message}`);
    process.exit(1);
  }
}
