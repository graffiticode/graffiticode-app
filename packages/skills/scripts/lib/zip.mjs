// A deterministic ZIP writer: same entries in, byte-identical archive out.
//
// Written by hand rather than shelling out, because both obvious shortcuts are
// disqualified:
//
//   `git archive --format=zip` can only emit blobs that exist in the tree, so it
//   cannot inject a GENERATED plugin.json and cannot restructure `render/` into
//   `skills/render/`. Those are the two things the packager exists to do.
//
//   `zip -X` cannot be deterministic. ZIP stores MS-DOS LOCAL time, and zip
//   converts the filesystem mtime in the current timezone — so the same bytes
//   packed in two timezones produce two different archives. The mtimes
//   themselves come from when the staging dir happened to be written, which is
//   nondeterministic by construction. `-X` drops the UT/Ux extra fields but not
//   the host byte, and macOS ships an Apple-modified Info-ZIP whose deflate
//   output need not match Ubuntu's stock build.
//
// Determinism is the point: the artifact's SHA-256 is what lets us answer "is
// the ZIP the portal holds the ZIP this repo produces?" — a question the
// submission runbook has never been able to answer.

import zlib from "node:zlib";

// STORE, not DEFLATE. Deflate output depends on the bundled zlib version, so a
// Node 20 CI build and a Node 22 laptop build could differ byte-for-byte while
// being semantically identical. The payload is tens of kilobytes against a
// 100 MB cap — compression buys nothing here and costs reproducibility.
const METHOD_STORE = 0;

// Fixed 1980-01-01 00:00. The DOS date/time fields carry no information the
// portal uses, and every conversion from a real clock is a timezone bug waiting
// to happen. A constant has no timezone.
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;

// Bit 11: filenames are UTF-8. No data-descriptor bit — every size and CRC is
// known up front because the whole archive is assembled in memory.
const FLAG_UTF8 = 0x0800;

const VERSION_NEEDED = 20; // spec 2.0
const VERSION_MADE_BY = (3 << 8) | VERSION_NEEDED; // 3 = Unix
// Fixed mode (0100644) for every entry, regardless of the staged files' actual
// permissions. `>>> 0` is load-bearing: JS bitwise operators work on SIGNED
// 32-bit ints, and 0o100644 << 16 overflows to a negative number that
// writeUInt32LE rejects outright.
const EXTERNAL_ATTRS = (0o100644 << 16) >>> 0;

const MAX_ENTRIES = 0xffff; // without Zip64
const MAX_BYTES = 0xffffffff;

function crc32(buf) {
  if (typeof zlib.crc32 !== "function") {
    // Node added zlib.crc32 in 20.15. package.json declares the floor; this is
    // the readable failure for anyone below it, instead of "z.crc32 is not a
    // function" from three frames down.
    throw new Error("zlib.crc32 requires Node >= 20.15 — upgrade Node and retry");
  }
  return zlib.crc32(buf);
}

/**
 * Build a ZIP archive from in-memory entries.
 *
 * Callers pass the entry list explicitly; this never walks a directory. That is
 * what structurally excludes .DS_Store, __MACOSX/._* AppleDouble files, APFS
 * NFD-normalized names and filesystem mtimes from the artifact — none of them
 * can reach a writer that never reads a directory.
 *
 * @param {{path: string, bytes: Buffer}[]} entries
 * @returns {Buffer}
 */
export function writeZip(entries) {
  // Sort by raw UTF-8 path bytes, NOT localeCompare: ICU collation varies with
  // locale and Node build, which would make entry order machine-dependent.
  const sorted = [...entries].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")),
  );

  if (sorted.length > MAX_ENTRIES) {
    throw new Error(`${sorted.length} entries exceeds the ${MAX_ENTRIES} limit (Zip64 not implemented)`);
  }

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of sorted) {
    const name = Buffer.from(entry.path, "utf8");
    const data = entry.bytes;
    const crc = crc32(data);

    if (offset > MAX_BYTES || data.length > MAX_BYTES) {
      throw new Error(`archive exceeds 4 GiB at ${entry.path} (Zip64 not implemented)`);
    }

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(METHOD_STORE, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed == uncompressed under STORE
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // no extra field
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); // central directory header signature
    central.writeUInt16LE(VERSION_MADE_BY, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(METHOD_STORE, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // no extra field
    central.writeUInt16LE(0, 32); // no comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(EXTERNAL_ATTRS, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // no archive comment

  return Buffer.concat([...locals, ...centrals, end]);
}
