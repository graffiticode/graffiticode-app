// Test support: the app in-process (no network), a fetch stub for the hosts
// core reads (language server via the API gateway, GitHub for skills), and
// response validation against openapi.yaml.
import assert from "node:assert/strict";
import { loadSpec } from "../src/spec.ts";
import { createAjv, deref } from "../src/validate.ts";

export const API = "http://api.test";
process.env.NEXT_PUBLIC_GC_API_URL = API;
process.env.OPENAPI_PUBLIC_URL = "https://openapi.test/v1";
process.env.GRAFFITICODE_SKILLS_TTL_MS = "0";

export const fetched: string[] = [];
const realFetch = globalThis.fetch;
export const routes = new Map<RegExp, (url: string) => Response>();
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  fetched.push(url);
  for (const [re, respond] of routes) if (re.test(url)) return respond(url);
  if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
  throw new Error(`test: refused fetch ${url}`);
}) as typeof fetch;

export const ok = (body: unknown, type = "application/json") =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers: { "content-type": type } });

// The language server, as the API gateway serves it.
routes.set(/\/L0180\/language-info\.json/, () => ok({
  description: "Quizzes", authoring_guide: "Describe the questions.", supported_item_types: ["mcq"],
  example_prompts: [{ prompt: "A 3-question quiz on fractions" }],
}));
routes.set(/\/L0180\/usage-guide\.md/, () => ok("# L0180 guide\n\nWrite questions.", "text/markdown"));
routes.set(/\/L0180\/scope\.json/, () => ok({ summary: "quizzes", in_scope: ["quizzes"], out_of_scope: ["spreadsheets"] }));
routes.set(/\/L0184\/(language-info\.json|usage-guide\.md|user-guide\.md|scope\.json)/, () => new Response("", { status: 404 }));

// The skills, in graffiticode-app's packages/skills on GitHub.
routes.set(/api\.github\.com\/repos\/graffiticode\/graffiticode-app\/contents\/packages\/skills\?/, () =>
  ok([{ type: "dir", name: "graffiticode-render" }, { type: "file", name: "README.md" }]));
routes.set(/raw\.githubusercontent\.com\/graffiticode\/graffiticode-app\/main\/packages\/skills\/graffiticode-render\/SKILL\.md/, () =>
  ok("---\nname: Rendering items\ndescription: >\n  How to show an item\n  to the user.\n---\n# Rendering\n", "text/markdown"));

export const spec = loadSpec();
const ajv = createAjv();

// Asserts a response matches the operation's documented response.
export async function conforms(res: Response, operationId: string) {
  const op = Object.values<any>(spec.paths).flatMap((item: any) => Object.values<any>(item)).find((o: any) => o?.operationId === operationId);
  assert.ok(op, `no operation ${operationId}`);
  const documented = op.responses[String(res.status)];
  assert.ok(documented, `${operationId}: status ${res.status} is not documented`);
  const content = deref(spec, documented).content;
  if (!content) return null;
  const type = (res.headers.get("content-type") ?? "").split(";")[0];
  const media = content[type];
  assert.ok(media, `${operationId} ${res.status}: content-type ${type} is not documented`);
  const text = await res.text();
  if (!type.endsWith("json")) return text;
  const body = JSON.parse(text);
  const validate = ajv.compile(deref(spec, media.schema));
  assert.ok(validate(body), `${operationId} ${res.status}: ${JSON.stringify(validate.errors)}`);
  return body;
}
