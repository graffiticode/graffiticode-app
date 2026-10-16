// The console's GraphQL endpoint, for the one item operation that runs there:
// get_spec calls a model, and model calls run only in the console, beside the
// generator and the key (as for MCP in core mode).
import { ApiProblem } from "./problems.js";

const consoleApi = () => process.env.GRAFFITICODE_CONSOLE_URL || "https://console.graffiticode.org/api";

const GET_SPEC = `query GetSpec($id: String!) { spec(id: $id) { spec lang itemId coverage { checked missing } } }`;

export async function consoleSpec(id: string, forward: Record<string, string>) {
  let res: Response;
  try {
    res = await fetch(consoleApi(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...forward },
      body: JSON.stringify({ query: GET_SPEC, variables: { id } }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw new ApiProblem(503, "unavailable", "Temporarily unavailable", { detail: "The spec service didn't answer. Try again.", headers: { "Retry-After": "30" } });
  }
  const body: any = await res.json().catch(() => null);
  const error = body?.errors?.[0];
  if (error || !body?.data?.spec) {
    const message = String(error?.message ?? `status ${res.status}`);
    if (/not found/i.test(message)) throw new ApiProblem(404, "not_found", "Not found", { detail: `Item ${id} not found.` });
    if (/no (associated )?task|not ready|generating/i.test(message)) throw new ApiProblem(409, "not_ready", "Not ready", { detail: "The item has no content yet." });
    throw new ApiProblem(503, "unavailable", "Temporarily unavailable", { detail: `The spec couldn't be made: ${message}`, headers: { "Retry-After": "30" } });
  }
  return body.data.spec as { spec: string; lang: string; itemId: string; coverage: { checked: number; missing: string[] } };
}
