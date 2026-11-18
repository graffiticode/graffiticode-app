// What an installation's browser surfaces serve from the server (installations
// plan, P3, slice 3): security headers, brand images, document metadata and
// page copy.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { checkAsset } from "../src/profile/assets.js";
import { consoleCsp, decodeSecurityHeaders, encodeSecurityHeaders, SECURITY_HEADERS_ENV } from "../src/profile/security-headers.js";
import { installationAsset, installationSecurityHeaders, loadInstallation, publishSecurityHeaders, resetInstallation } from "../src/profile/runtime.js";
import { buildPublicConfig, BUILT_IN_THUMBNAILS } from "../src/profile/public-config-server.js";
import { loadProfile } from "../src/profile/load.js";

const EXAMPLE = new URL("./fixtures/installation-example", import.meta.url).pathname;
const ENV = { GOOGLE_CLOUD_PROJECT: "example-installation" } as any;
afterEach(() => resetInstallation());

function variant(edit: (p: any, dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "profile-"));
  cpSync(EXAMPLE, dir, { recursive: true });
  const p = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8"));
  edit(p, dir);
  writeFileSync(join(dir, "profile.json"), JSON.stringify(p));
  return dir;
}

// Today's console policy, verbatim from next.config.mjs before slice 3.
const TODAY = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.stripe.com https://*.firebaseio.com https://*.googleapis.com https://apis.google.com https://*.privy.io https://auth.privy.io; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https: https://*.privy.io; connect-src 'self' https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com https://*.stripe.com https://api.graffiticode.org https://auth.graffiticode.org https://*.privy.io https://auth.privy.io wss://*.privy.io https://api.openai.com https://api.anthropic.com; frame-src 'self' https://*.stripe.com https://*.privy.io https://auth.privy.io; worker-src 'self' blob:; object-src 'none'; base-uri 'self'";

test("without a profile, the console's policy is today's, byte for byte; the app and MCP pages are unchanged", () => {
  assert.equal(consoleCsp({ api: "https://api.graffiticode.org", auth: "https://auth.graffiticode.org" }), TODAY);
  assert.deepEqual(installationSecurityHeaders("console"), [["Content-Security-Policy-Report-Only", TODAY]]);
  assert.deepEqual(installationSecurityHeaders("app"), []);
  assert.deepEqual(installationSecurityHeaders("mcp-page"), []);
});

test("with a profile, every surface's policy is built from its hosts, in its mode", () => {
  loadInstallation({ ...ENV, PROFILE_DIR: variant(p => { p.hosts.api = "https://api.example.test"; p.hosts.auth = "https://auth.example.test"; }) });
  const [[name, value]] = installationSecurityHeaders("console");
  assert.equal(name, "Content-Security-Policy-Report-Only");
  assert.match(value, /connect-src [^;]*https:\/\/api\.example\.test https:\/\/auth\.example\.test/);
  assert.doesNotMatch(value, /graffiticode\.org/);
  const [[appName, app]] = installationSecurityHeaders("app");
  assert.equal(appName, "Content-Security-Policy-Report-Only");
  assert.match(app, /frame-src 'self' https:\/\/api\.example\.test/);
  assert.equal(installationSecurityHeaders("mcp-page")[0][0], "Content-Security-Policy-Report-Only");
  resetInstallation();
  loadInstallation({ ...ENV, PROFILE_DIR: variant(p => { p.csp = { mode: "enforce" }; }) });
  for (const s of ["console", "app", "mcp-page"] as const) assert.equal(installationSecurityHeaders(s)[0][0], "Content-Security-Policy", s);
});

test("the startup handoff to the middleware is always the server's, and refuses anything malformed", () => {
  const env: any = { [SECURITY_HEADERS_ENV]: encodeSecurityHeaders([["Content-Security-Policy", "default-src *"]]) };
  publishSecurityHeaders("console", env);
  assert.deepEqual(decodeSecurityHeaders(env[SECURITY_HEADERS_ENV]), [["Content-Security-Policy-Report-Only", TODAY]], "an outside value is overwritten");
  publishSecurityHeaders("app", env);
  assert.deepEqual(decodeSecurityHeaders(env[SECURITY_HEADERS_ENV]), [], "no headers is a value, not a missing one");
  for (const bad of [undefined, "", "{", "[]", '{"v":2,"headers":[]}', '{"v":1,"headers":[["Bad Name","x"]]}', '{"v":1,"headers":[["X","a\\r\\nSet-Cookie: x"]]}']) {
    assert.equal(decodeSecurityHeaders(bad as any), null, String(bad));
  }
});

// PNG and ICO builders for the structure checks.
const chunk = (type: string, data: Buffer) => {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
  return Buffer.concat([len, t, data, crc]);
};
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = (w: number, h: number, { colorType = 6, interlace = 0 } = {}) => {
  const d = Buffer.alloc(13); d.writeUInt32BE(w, 0); d.writeUInt32BE(h, 4); d.set([8, colorType, 0, 0, interlace], 8);
  return chunk("IHDR", d);
};
// PNGs a structural check alone accepts but a decoder refuses.
const UNDECODABLE = {
  // 1x1, Adam7-interlaced: its one row (in the first pass) uses filter 5, which doesn't exist.
  "an interlaced PNG with an invalid row filter": Buffer.concat([SIG, ihdr(1, 1, { interlace: 1 }), chunk("IDAT", deflateSync(Buffer.from([5, 1, 2, 3, 4]))), chunk("IEND", Buffer.alloc(0))]),
  // 1x1, indexed, with an empty palette for its one index.
  "an indexed PNG with an empty palette": Buffer.concat([SIG, ihdr(1, 1, { colorType: 3 }), chunk("PLTE", Buffer.alloc(0)), chunk("IDAT", deflateSync(Buffer.from([0, 0]))), chunk("IEND", Buffer.alloc(0))]),
};
const rgba = (w: number, h: number) => Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 4, 0x7f)])));
const pngOf = (w: number, h: number, idat: Buffer = deflateSync(rgba(w, h)), extra: Buffer[] = []) =>
  Buffer.concat([SIG, ihdr(w, h), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0)), ...extra]);
const icoOf = (images: Buffer[], { countOverride }: { countOverride?: number } = {}) => {
  const dir = Buffer.alloc(6); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(countOverride ?? images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(img => { const e = Buffer.alloc(16); e[0] = 16; e[1] = 16; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(img.length, 8); e.writeUInt32LE(offset, 12); offset += img.length; return e; });
  return Buffer.concat([dir, ...entries, ...images]);
};
// A 16x16, 32-bit BMP image as an ICO stores it (double height for the mask).
const bmp = (truncateBy = 0) => {
  const h = Buffer.alloc(40); h.writeUInt32LE(40, 0); h.writeInt32LE(16, 4); h.writeInt32LE(32, 8); h.writeUInt16LE(1, 12); h.writeUInt16LE(32, 14);
  const full = Buffer.concat([h, Buffer.alloc(16 * 16 * 4), Buffer.alloc(16 * 4)]);
  return full.subarray(0, full.length - truncateBy);
};

test("brand images are checked by their whole structure, for the slot they're served in", () => {
  const problem = (kind: any, bytes: Uint8Array) => (checkAsset(kind, bytes) as any).problem as string | undefined;
  const ok = (kind: any, bytes: Uint8Array) => (checkAsset(kind, bytes) as any).type as string | undefined;
  assert.deepEqual({ ...(checkAsset("icon", pngOf(8, 4)) as any), bytes: undefined }, { type: "image/png", width: 8, height: 4, bytes: undefined });
  assert.equal(ok("favicon", readFileSync(join(EXAMPLE, "assets/favicon.ico"))), "image/x-icon");
  assert.equal(ok("favicon", icoOf([bmp()])), "image/x-icon", "a BMP-based ICO");
  assert.match(problem("icon", readFileSync(join(EXAMPLE, "assets/favicon.ico")))!, /the icon must be image\/png/);
  assert.match(problem("icon", Buffer.from("icon\n"))!, /isn't a PNG or ICO/);
  assert.match(problem("icon", new Uint8Array())!, /empty/);
  assert.match(problem("icon", Buffer.concat([pngOf(8, 4), Buffer.alloc(1_000_001)]))!, /limit/);

  // SVG is refused everywhere, however it is written.
  for (const svg of [
    readFileSync(join(EXAMPLE, "assets/logo.svg")),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>'),
    Buffer.from('<s:svg xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></s:svg>'),
    Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
  ]) for (const kind of ["logo", "icon", "favicon"]) assert.ok(problem(kind, svg), `${kind}: ${svg.toString().slice(0, 40)}`);
  assert.match(problem("logo", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))!, /SVG images aren't accepted/);

  // A PNG must be complete and decodable.
  const good = pngOf(8, 4);
  assert.match(problem("icon", good.subarray(0, 33))!, /truncated PNG/, "only the signature and header");
  const corrupt = Buffer.from(good); corrupt[good.length - 20] ^= 0xff;
  assert.match(problem("icon", corrupt)!, /corrupt PNG|truncated/);
  assert.match(problem("icon", pngOf(8, 4, Buffer.from("not deflate data")))!, /doesn't decompress/);
  assert.match(problem("icon", pngOf(8, 4, deflateSync(rgba(8, 2))))!, /bytes of image data where its header needs/);
  assert.match(problem("icon", pngOf(8, 4, undefined, [Buffer.from("trailing")]))!, /data after its end/);
  assert.match(problem("icon", Buffer.concat([SIG, ihdr(8, 4), chunk("IEND", Buffer.alloc(0))]))!, /no image data/);
  assert.match(problem("icon", Buffer.concat([SIG, ihdr(5000, 5000), chunk("IDAT", deflateSync(Buffer.alloc(10))), chunk("IEND", Buffer.alloc(0))]))!, /limit is 4096/);
  // ...and decode in full (pngjs).
  for (const [what, bytes] of Object.entries(UNDECODABLE)) {
    assert.match(problem("icon", bytes) ?? "accepted", /doesn't decode/, what);
    assert.match(problem("favicon", icoOf([bytes])) ?? "accepted", /image 1 is a PNG that doesn't decode/, `${what}, inside an ICO`);
  }
  // A valid interlaced PNG and a valid indexed one decode.
  assert.equal(ok("icon", Buffer.concat([SIG, ihdr(1, 1, { interlace: 1 }), chunk("IDAT", deflateSync(Buffer.from([0, 1, 2, 3, 4]))), chunk("IEND", Buffer.alloc(0))])), "image/png");
  assert.equal(ok("icon", Buffer.concat([SIG, ihdr(1, 1, { colorType: 3 }), chunk("PLTE", Buffer.from([9, 9, 9])), chunk("IDAT", deflateSync(Buffer.from([0, 0]))), chunk("IEND", Buffer.alloc(0))])), "image/png");

  // An ICO must name its images, and each must be complete.
  const six = Buffer.from([0, 0, 1, 0, 1, 0]);
  assert.match(problem("favicon", six)!, /truncated ICO/, "a directory with no image entries");
  assert.match(problem("favicon", icoOf([], { countOverride: 0 }))!, /no images/);
  const outside = icoOf([good]); outside.writeUInt32LE(outside.length, 6 + 12);
  assert.match(problem("favicon", outside)!, /isn't inside the file/);
  assert.match(problem("favicon", icoOf([good.subarray(0, 40)]))!, /image 1 is a truncated PNG/);
  assert.match(problem("favicon", icoOf([bmp(100)]))!, /image 1 is truncated/);
  assert.match(problem("favicon", icoOf([Buffer.from("not an image at all, but long enough to have a header....")]))!, /neither a PNG nor a BMP/);
});

test("a profile with a missing or invalid image doesn't load", () => {
  const pngHead = readFileSync(join(EXAMPLE, "assets/icon.png")).subarray(0, 33);
  assert.throws(() => loadProfile(variant(p => { delete p.brand.assets.icon; })), /brand\/assets.*icon/);
  assert.throws(() => loadProfile(variant((_, dir) => unlinkSync(join(dir, "assets/icon.png")))), /file not found: assets\/icon\.png/);
  assert.throws(() => loadProfile(variant((_, dir) => writeFileSync(join(dir, "assets/icon.png"), "not an image"))), /brand\/assets\/icon.*isn't a PNG or ICO/);
  assert.throws(() => loadProfile(variant((_, dir) => writeFileSync(join(dir, "assets/icon.png"), pngHead))), /brand\/assets\/icon.*truncated PNG/);
  assert.throws(() => loadProfile(variant((_, dir) => writeFileSync(join(dir, "assets/favicon.ico"), Buffer.from([0, 0, 1, 0, 1, 0])))), /brand\/assets\/favicon.*truncated ICO/);
  for (const [what, bytes] of Object.entries(UNDECODABLE)) {
    assert.throws(() => loadProfile(variant((_, dir) => writeFileSync(join(dir, "assets/icon.png"), bytes))), /brand\/assets\/icon.*doesn't decode/, what);
  }
  assert.throws(() => loadProfile(variant(p => { p.brand.assets.logo = "assets/logo.svg"; })), /brand\/assets\/logo.*SVG images aren't accepted/);
  assert.throws(() => loadProfile(variant(p => { p.brand.assets.icon = "assets/favicon.ico"; })), /icon must be image\/png/);
});

test("the images served are the ones loaded at startup, whatever happens to the files", () => {
  const dir = variant(() => {});
  loadInstallation({ ...ENV, PROFILE_DIR: dir });
  const before = Buffer.from(installationAsset("icon")!.bytes);
  writeFileSync(join(dir, "assets/icon.png"), "changed");
  assert.ok(Buffer.from(installationAsset("icon")!.bytes).equals(before));
  assert.equal(installationAsset("icon")!.type, "image/png");
  resetInstallation();
  assert.equal(installationAsset("icon"), null, "no images without a profile: the build's own files are served");
});

test("metadata and copy: today's without a profile; the installation's, or derived from its brand, with one", () => {
  const none = buildPublicConfig({} as any);
  assert.deepEqual(none.metadata, {
    console: { title: "Console", description: "Graffiticode - A software studio" },
    app: { title: "Graffiticode", description: "Render Graffiticode items and tasks as forms — created via the Graffiticode MCP server at mcp.graffiticode.org/mcp" },
  });
  assert.deepEqual(none.copy, { consoleHome: null, consoleAbout: null });
  assert.equal(none.hosts.thumbnails, BUILT_IN_THUMBNAILS);

  loadInstallation({ ...ENV, PROFILE_DIR: EXAMPLE });
  const derived = buildPublicConfig({} as any);
  assert.deepEqual(derived.metadata.console, { title: "Example Console", description: "Example Console" });
  assert.equal(derived.metadata.app.description, "Render Example items and tasks as forms — created via the Example MCP server at mcp.example.test/mcp");
  assert.match(derived.copy.consoleHome!, /^# Welcome to Example/);
  assert.match(derived.copy.consoleAbout!, /operated by \[Example Inc\.\]\(https:\/\/example\.test\)/);
  assert.doesNotMatch(JSON.stringify(derived.metadata) + JSON.stringify(derived.copy), /Graffiticode|graffiticode/);
  resetInstallation();

  const own = variant((p, dir) => {
    p.brand.tagline = "Assessments that build themselves.";
    p.hosts.thumbnails = "https://cdn.example.test/thumbs/";
    p.copy = { ...(p.copy ?? {}), "console.title": "copy/console-title.txt", "console.home": "copy/console-home.md" };
    writeFileSync(join(dir, "copy/console-title.txt"), "{{brand.name}} Studio\n");
    writeFileSync(join(dir, "copy/console-home.md"), "# Hello from {{brand.name}}\n");
  });
  loadInstallation({ ...ENV, PROFILE_DIR: own });
  const c = buildPublicConfig({} as any);
  assert.deepEqual(c.metadata.console, { title: "Example Studio", description: "Assessments that build themselves." });
  assert.equal(c.copy.consoleHome, "# Hello from Example");
  assert.equal(c.hosts.thumbnails, "https://cdn.example.test/thumbs");
});

const GRAFFITICODE = process.env.GRAFFITICODE_PROFILE_DIR ?? null;
test("with the Graffiticode profile, the console's policy, metadata, thumbnails and icon are today's", { skip: !GRAFFITICODE && "integration gate: set GRAFFITICODE_PROFILE_DIR to the Graffiticode profile" }, () => {
  const none = { headers: installationSecurityHeaders("console"), config: buildPublicConfig({} as any) };
  loadInstallation({ PROFILE_DIR: GRAFFITICODE! } as any);
  const withProfile = buildPublicConfig({} as any);
  assert.deepEqual(installationSecurityHeaders("console"), none.headers);
  assert.deepEqual(withProfile.metadata, none.config.metadata);
  assert.equal(withProfile.hosts.thumbnails, none.config.hosts.thumbnails);
  // Today's /favicon.png, /logo.png and the app's icon are one file; the profile's icon is it.
  const today = readFileSync(new URL("../../console/public/favicon.png", import.meta.url));
  assert.ok(Buffer.from(installationAsset("icon")!.bytes).equals(today));
  assert.ok(today.equals(readFileSync(new URL("../../console/public/logo.png", import.meta.url))));
  assert.ok(today.equals(readFileSync(new URL("../../app/public/icon.png", import.meta.url))));
  assert.match(withProfile.copy.consoleHome!, /^# Welcome to Graffiticode/);
});
