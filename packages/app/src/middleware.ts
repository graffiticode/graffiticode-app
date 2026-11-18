// Security headers on every response (installations plan, P3, slice 3), set
// from the installation the server runs as: with a profile, its policy in its
// mode; without one, none, as before. The middleware runs on the edge runtime,
// which can't load the installation, so the server computes them at startup
// from the pinned profile (instrumentation-node.ts) and hands them over in its
// environment. Without that value it refuses to serve.
import { NextResponse } from "next/server";
import { decodeSecurityHeaders, SECURITY_HEADERS_ENV } from "@graffiticode-app/core/profile/security-headers";

export function middleware() {
  const headers = decodeSecurityHeaders(process.env[SECURITY_HEADERS_ENV]);
  if (!headers) {
    return new NextResponse("This server's security headers aren't configured.", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const res = NextResponse.next();
  for (const [name, value] of headers) res.headers.set(name, value);
  return res;
}

export const config = { matcher: "/:path*" };
