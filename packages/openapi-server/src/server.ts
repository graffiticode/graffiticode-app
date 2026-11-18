// openapi-service entry point (Cloud Run): serves createApp() on $PORT.
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadInstallation } from "@graffiticode-app/core/profile/runtime";

// The installation profile (PROFILE_DIR), loaded and validated before the
// first request. An invalid profile stops the start.
const receipt = loadInstallation();
if (receipt) console.log(`[installation] ${JSON.stringify(receipt)}`);

const port = Number(process.env.PORT || 8080);
serve({ fetch: createApp().fetch, port }, () => console.log(`Graffiticode API listening on :${port}`));
