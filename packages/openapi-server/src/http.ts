// Small HTTP helpers shared by the routes.
import { createHash } from "node:crypto";
import type { Context } from "hono";

// A representation with a strong ETag; 304 when the client already has it.
export function cached(c: Context, body: string, contentType: string, maxAge: number) {
  const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
  c.header("ETag", etag);
  c.header("Cache-Control", `public, max-age=${maxAge}`);
  const match = c.req.header("if-none-match");
  if (match && match.split(",").map(s => s.trim().replace(/^W\//, "")).includes(etag)) {
    return c.body(null, 304);
  }
  return c.body(body, 200, { "Content-Type": contentType });
}

export const json = (value: unknown) => JSON.stringify(value);

// Opaque page cursors: an offset, base64url-encoded so clients don't build them.
export const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const o = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))?.o;
    if (Number.isInteger(o) && o >= 0) return o;
  } catch { /* fall through */ }
  return -1;
}

// Language ids travel as L####; core takes the bare number.
export const bareLanguageId = (id: string) => id.replace(/^L/i, "");
export const languageId = (id: string) => `L${bareLanguageId(id)}`;
