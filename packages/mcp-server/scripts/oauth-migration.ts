// The OAuth-store handover's operator jobs (installations plan, P5), run with
// the MCP service's configuration (PROFILE_DIR, its storage, the auth
// service's URL and internal key):
//
//   npm run oauth-migration -- report   what's left: retire the fallback only
//                                       when it says fallbackRetirable
//   npm run oauth-migration -- import   copy clients, import live tokens
//   npm run oauth-migration -- sweep    complete records left prepared
//
// It needs OAUTH_STORE=migrating with OAUTH_MIGRATION_VERIFIED_CONTRACT, like
// the service, and the source fenced: import refuses to run before the fence.
// Every job is safe to re-run. It prints one JSON line.
import { loadInstallation } from "@graffiticode-app/core/profile/runtime";
import { LocalOAuthStore } from "@graffiticode-app/core/oauth/local-store";
import { MigratingOAuthStore } from "@graffiticode-app/core/oauth/store";
import { importInventory, report, sweep } from "@graffiticode-app/core/oauth/migration";
import { LEGACY_INSTALLATION_ID } from "@graffiticode-app/core/oauth/records";

const command = process.argv[2];
if (!["report", "import", "sweep"].includes(command ?? "")) {
  console.error("usage: npm run oauth-migration -- report | import | sweep");
  process.exit(2);
}

loadInstallation(process.env, { requireStorage: true });
const { selectedOAuthStore, legacySource } = await import("../src/oauth/firestore-store.js");
const { mode, store } = selectedOAuthStore();
if (mode !== "migrating" || !(store instanceof MigratingOAuthStore)) {
  console.error(`OAUTH_STORE is ${mode}; these jobs run only while migrating.`);
  process.exit(2);
}
const local = new LocalOAuthStore();
const result = command === "report" ? await report(local, legacySource, LEGACY_INSTALLATION_ID)
  : command === "import" ? await importInventory(store, local, legacySource, LEGACY_INSTALLATION_ID)
    : await sweep(store, local);
console.log(JSON.stringify({ command, ...result }));
