// An installation's brand images (installations plan, P3, slice 3): checked
// when the profile loads, by their whole structure and not their names, and
// pinned for the process's life, so what a server serves is what the digest
// covered.
//
// The browser surfaces serve them at fixed URLs (the console's /favicon.png
// and /logo.png, the app's /icon.png), so each slot admits only the types it
// can be served as. SVG is refused everywhere for now: it is a document that
// can run script (in more spellings than a pattern can catch), and nothing
// serves one. Admitting it needs a namespace-aware allowlist parser.
//
// Server-only (the profile loader and CLI). A PNG passes the structural checks
// below (which also bound what decoding may cost), then must decode, in full,
// with pngjs: a maintained decoder decides decodability, not this file.
import { inflateSync } from "node:zlib";
import pngjs from "pngjs";

export type AssetKind = "logo" | "favicon" | "icon";
export type AssetType = "image/png" | "image/x-icon";
export type CheckedAsset = { type: AssetType; bytes: Uint8Array; width?: number; height?: number };

export const MAX_ASSET_BYTES = 1_000_000;
// Larger than any icon needs; bounds what a header can make us decompress.
export const MAX_DIMENSION = 4096;

const ALLOWED: Record<AssetKind, AssetType[]> = {
  icon: ["image/png"],
  logo: ["image/png"],
  favicon: ["image/png", "image/x-icon"],
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array, start: number, end: number) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const i32le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);

const isPngSignature = (b: Uint8Array, at = 0) => b.length >= at + 8 && PNG_SIGNATURE.every((x, i) => b[at + i] === x);

// Bits per pixel for each valid (color type, bit depth) pair.
const PNG_BPP: Record<number, Record<number, number>> = {
  0: { 1: 1, 2: 2, 4: 4, 8: 8, 16: 16 }, // grayscale
  2: { 8: 24, 16: 48 },                   // RGB
  3: { 1: 1, 2: 2, 4: 4, 8: 8 },          // palette
  4: { 8: 16, 16: 32 },                   // gray + alpha
  6: { 8: 32, 16: 64 },                   // RGBA
};

// The decompressed size a PNG's header implies: one filter byte per row, for
// the whole image or for each Adam7 pass.
function expectedPngData(width: number, height: number, bpp: number, interlaced: boolean) {
  const rows = (w: number, h: number) => (w === 0 || h === 0 ? 0 : h * (1 + Math.ceil((w * bpp) / 8)));
  if (!interlaced) return rows(width, height);
  const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  return passes.reduce((n, [x0, y0, dx, dy]) => n + rows(Math.ceil((width - x0) / dx), Math.ceil((height - y0) / dy)), 0);
}

// A complete, decodable PNG, or why not.
function checkPng(b: Uint8Array): { width: number; height: number } | string {
  if (!isPngSignature(b)) return "isn't a PNG";
  let at = 8;
  let header: { width: number; height: number; bpp: number; colorType: number; interlaced: boolean } | null = null;
  let sawPalette = false;
  let ended = false;
  const data: Uint8Array[] = [];
  while (at < b.length) {
    if (ended) return "is a PNG with data after its end";
    if (at + 12 > b.length) return "is a truncated PNG";
    const len = u32(b, at);
    const type = String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7]);
    const start = at + 8;
    const end = start + len;
    if (end + 4 > b.length) return `is a truncated PNG (its ${type} chunk runs past the end)`;
    if (crc32(b, at + 4, end) !== u32(b, end)) return `is a corrupt PNG (bad ${type} checksum)`;
    if (!header && type !== "IHDR") return "is a PNG without its IHDR header";
    if (type === "IHDR") {
      if (header) return "is a PNG with two headers";
      if (len !== 13) return "is a PNG with a malformed header";
      const width = u32(b, start), height = u32(b, start + 4);
      const depth = b[start + 8], colorType = b[start + 9];
      const bpp = PNG_BPP[colorType]?.[depth];
      if (!width || !height) return "is a PNG with no size";
      if (width > MAX_DIMENSION || height > MAX_DIMENSION) return `is a ${width}x${height} PNG; the limit is ${MAX_DIMENSION} on a side`;
      if (!bpp) return "is a PNG with an invalid color type or bit depth";
      if (b[start + 10] !== 0 || b[start + 11] !== 0 || b[start + 12] > 1) return "is a PNG with an unknown compression, filter or interlace method";
      header = { width, height, bpp, colorType, interlaced: b[start + 12] === 1 };
    } else if (type === "PLTE") {
      sawPalette = true;
    } else if (type === "IDAT") {
      data.push(b.subarray(start, end));
    } else if (type === "IEND") {
      ended = true;
    }
    at = end + 4;
  }
  if (!header) return "is a PNG without its IHDR header";
  if (!ended) return "is a truncated PNG (no IEND)";
  if (!data.length) return "is a PNG with no image data";
  if (header.colorType === 3 && !sawPalette) return "is a palette PNG without a palette";
  const expected = expectedPngData(header.width, header.height, header.bpp, header.interlaced);
  let pixels: Uint8Array;
  try {
    pixels = inflateSync(Buffer.concat(data.map(d => Buffer.from(d.buffer, d.byteOffset, d.byteLength))), { maxOutputLength: expected + 1 });
  } catch {
    return "is a PNG whose image data doesn't decompress";
  }
  if (pixels.length !== expected) return `is a PNG with ${pixels.length} bytes of image data where its header needs ${expected}`;
  // The image must decode in full: row filters (interlaced or not), palette
  // and every pixel. The checks above have already bounded its size.
  try {
    const decoded = pngjs.PNG.sync.read(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
    if (decoded.width !== header.width || decoded.height !== header.height) return "is a PNG that decodes to a different size than its header says";
  } catch (err) {
    return `is a PNG that doesn't decode (${String((err as Error).message ?? err).slice(0, 80)})`;
  }
  return { width: header.width, height: header.height };
}

// A complete ICO: a directory naming at least one image, each inside the
// file, and each a complete PNG or BMP.
function checkIco(b: Uint8Array): true | string | null {
  if (b.length < 6 || b[0] !== 0 || b[1] !== 0 || b[2] !== 1 || b[3] !== 0) return null; // not an ICO
  const count = u16le(b, 4);
  if (count === 0) return "is an ICO with no images";
  if (b.length < 6 + 16 * count) return "is a truncated ICO (its directory runs past the end)";
  for (let i = 0; i < count; i++) {
    const e = 6 + 16 * i;
    const size = u32le(b, e + 8), offset = u32le(b, e + 12);
    if (size === 0 || offset < 6 + 16 * count || offset + size > b.length) return `is an ICO whose image ${i + 1} isn't inside the file`;
    const image = b.subarray(offset, offset + size);
    if (isPngSignature(image)) {
      const png = checkPng(image);
      if (typeof png === "string") return `is an ICO whose image ${i + 1} ${png}`;
      continue;
    }
    // A BMP image: BITMAPINFOHEADER, then the color table, pixels and mask.
    if (image.length < 40 || u32le(image, 0) !== 40) return `is an ICO whose image ${i + 1} is neither a PNG nor a BMP`;
    const width = i32le(image, 4), height2 = i32le(image, 8), planes = u16le(image, 12), bpp = u16le(image, 14);
    if (width <= 0 || width > 256 || height2 <= 0 || height2 % 2 || height2 / 2 > 256) return `is an ICO whose image ${i + 1} has an invalid size`;
    if (planes !== 1 || ![1, 4, 8, 24, 32].includes(bpp)) return `is an ICO whose image ${i + 1} has an invalid format`;
    if (u32le(image, 16) !== 0) return `is an ICO whose image ${i + 1} is compressed`;
    const height = height2 / 2;
    const palette = bpp <= 8 ? 4 * (u32le(image, 32) || 1 << bpp) : 0;
    const row = (bits: number) => Math.ceil((width * bits) / 32) * 4;
    const needed = 40 + palette + height * row(bpp) + height * row(1);
    if (image.length < needed) return `is an ICO whose image ${i + 1} is truncated`;
  }
  return true;
}

// What an asset's bytes are, or why it can't be served in its slot.
export function checkAsset(kind: AssetKind, bytes: Uint8Array): CheckedAsset | { problem: string } {
  if (bytes.length === 0) return { problem: "is empty" };
  if (bytes.length > MAX_ASSET_BYTES) return { problem: `is ${bytes.length} bytes; the limit is ${MAX_ASSET_BYTES}` };
  let found: CheckedAsset;
  if (isPngSignature(bytes)) {
    const png = checkPng(bytes);
    if (typeof png === "string") return { problem: png };
    found = { type: "image/png", bytes, ...png };
  } else {
    const ico = checkIco(bytes);
    if (typeof ico === "string") return { problem: ico };
    if (ico !== true) {
      const looksSvg = /^\s*(<\?xml|<!--|<svg|<!DOCTYPE\s+svg)/i.test(new TextDecoder().decode(bytes.subarray(0, 512)));
      return { problem: looksSvg ? "is an SVG; SVG images aren't accepted (they can run script)" : "isn't a PNG or ICO image" };
    }
    found = { type: "image/x-icon", bytes };
  }
  if (!ALLOWED[kind].includes(found.type)) {
    return { problem: `is ${found.type}; the ${kind} must be ${ALLOWED[kind].join(" or ")}` };
  }
  return found;
}
