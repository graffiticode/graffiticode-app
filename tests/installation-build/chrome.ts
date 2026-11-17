// A minimal headless Chrome driver over the DevTools protocol, for the
// installation gates (installations plan, P3, slice 2). No dependency: Node's
// WebSocket and a locally installed Chrome (CHROME_PATH, or the macOS default).
//
// Every request a page makes is paused (Fetch domain) and recorded. Requests to
// the server under test continue; requests anywhere else are blocked, so a
// page can show what it would have called (Firebase, Privy, Stripe, an auth or
// API host) without reaching any real service. A test may also answer a URL
// itself, to serve a failed, malformed or unsupported /api/config.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const chromePath = () => process.env.CHROME_PATH ?? DEFAULT_CHROME;
export const chromeAvailable = () => existsSync(chromePath());

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export type Respond = (url: string) => { status: number; body: string; contentType?: string } | null;

export class Chrome {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners: ((m: any) => void)[] = [];
  private constructor(private child: ChildProcess, private profileDir: string) {}

  static async launch(): Promise<Chrome> {
    const profileDir = mkdtempSync(join(tmpdir(), "chrome-"));
    const child = spawn(chromePath(), [
      "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`,
      "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank",
    ], { stdio: "ignore" });
    const portFile = join(profileDir, "DevToolsActivePort");
    for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise(r => setTimeout(r, 100));
    const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
    const c = new Chrome(child, profileDir);
    c.ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    await new Promise<void>((resolve, reject) => { c.ws.onopen = () => resolve(); c.ws.onerror = () => reject(new Error("devtools connection failed")); });
    c.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id && c.pending.has(m.id)) {
        const p = c.pending.get(m.id)!;
        c.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      } else {
        for (const l of c.listeners) l(m);
      }
    };
    return c;
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  // Opens `url` in a fresh page. `allowOrigin` requests continue; `respond` may
  // answer a request itself; everything else is blocked. Resolves once the
  // page has settled (`until` true, or the timeout), with every requested URL.
  async visit(url: string, opts: { allowOrigin: string; respond?: Respond; until?: string; timeoutMs?: number }) {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const requested: string[] = [];
    const console: string[] = [];
    const listener = (m: any) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === "Fetch.requestPaused") {
        const reqUrl: string = m.params.request.url;
        requested.push(reqUrl);
        const answer = opts.respond?.(reqUrl);
        if (answer) {
          void this.send("Fetch.fulfillRequest", {
            requestId: m.params.requestId, responseCode: answer.status,
            responseHeaders: [{ name: "Content-Type", value: answer.contentType ?? "application/json" }],
            body: Buffer.from(answer.body).toString("base64"),
          }, sessionId).catch(() => {});
        } else if (reqUrl.startsWith(opts.allowOrigin) || reqUrl.startsWith("data:") || reqUrl.startsWith("blob:")) {
          void this.send("Fetch.continueRequest", { requestId: m.params.requestId }, sessionId).catch(() => {});
        } else {
          void this.send("Fetch.failRequest", { requestId: m.params.requestId, errorReason: "BlockedByClient" }, sessionId).catch(() => {});
        }
      } else if (m.method === "Runtime.consoleAPICalled") {
        console.push(m.params.args.map((a: any) => a.value ?? a.description ?? "").join(" "));
      } else if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        console.push(`EXCEPTION: ${d.exception?.description ?? d.text}`);
      }
    };
    this.listeners.push(listener);
    await this.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId);
    await this.send("Runtime.enable", {}, sessionId);
    await this.send("Page.enable", {}, sessionId);
    await this.send("Page.navigate", { url }, sessionId);
    const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
    const evaluate = async (expression: string) =>
      (await this.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)).result?.value;
    while (Date.now() < deadline) {
      if (opts.until && await evaluate(opts.until).catch(() => false)) break;
      await new Promise(r => setTimeout(r, 200));
    }
    // A moment more, for requests a provider makes as it initializes.
    await new Promise(r => setTimeout(r, 2_000));
    const state = await evaluate(`({
      installation: document.documentElement.dataset.installation ?? null,
      installationError: document.documentElement.dataset.installationError ?? null,
      authProject: document.documentElement.dataset.authProject ?? null,
      config: document.querySelector("[data-config]")?.getAttribute("data-config") ?? null,
      text: document.body.innerText.slice(0, 2000),
      iframes: [...document.querySelectorAll("iframe")].map(f => f.src),
      scripts: [...document.querySelectorAll("script[src]")].map(s => s.src),
    })`);
    this.listeners = this.listeners.filter(l => l !== listener);
    await this.send("Target.closeTarget", { targetId }).catch(() => {});
    return { requested, console, ...state } as {
      requested: string[]; console: string[]; installation: string | null; installationError: string | null; authProject: string | null;
      config: string | null; text: string; iframes: string[]; scripts: string[];
    };
  }

  async close() {
    try { this.ws.close(); } catch { /* closing */ }
    const exited = new Promise(r => this.child.once("exit", r));
    this.child.kill();
    await exited;
    rmSync(this.profileDir, { recursive: true, force: true });
  }
}
