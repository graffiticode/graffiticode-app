// The API's own description and docs.
import type { Hono } from "hono";
import { asYaml, servedSpec } from "../spec.js";
import { cached, json } from "../http.js";

// Scalar's API reference, loaded from jsDelivr, pointed at this description.
const docsPage = () => `<!doctype html>
<html><head><meta charset="utf-8"><title>Graffiticode API</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><script id="api-reference" data-url="./openapi.json"></script>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1"></script></body></html>`;

export function metaRoutes(app: Hono, spec: any) {
  app.get("/openapi.json", (c) => cached(c, json(servedSpec(spec)), "application/json", 300));
  app.get("/openapi.yaml", (c) => cached(c, asYaml(servedSpec(spec)), "application/yaml", 300));
  app.get("/docs", (c) => c.html(docsPage()));
}
