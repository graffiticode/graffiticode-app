// openapi-service entry point (Cloud Run): serves createApp() on $PORT.
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const port = Number(process.env.PORT || 8080);
serve({ fetch: createApp().fetch, port }, () => console.log(`Graffiticode API listening on :${port}`));
