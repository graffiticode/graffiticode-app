// Lays out each standalone server as configs/Dockerfile.{console,app}.yaml do:
// the build's .next/static and public/ next to server.js. The browser gate
// loads pages, so it needs the same files a container serves.
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
for (const app of ["console", "app"]) {
  const pkg = join(ROOT, "packages", app);
  const server = join(pkg, ".next/standalone/packages", app);
  if (!existsSync(join(server, "server.js"))) throw new Error(`no standalone build of ${app} at ${server}`);
  rmSync(join(server, ".next/static"), { recursive: true, force: true });
  cpSync(join(pkg, ".next/static"), join(server, ".next/static"), { recursive: true });
  cpSync(join(pkg, "public"), join(server, "public"), { recursive: true });
}
