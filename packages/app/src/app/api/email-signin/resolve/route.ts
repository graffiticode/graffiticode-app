import { NextRequest, NextResponse } from "next/server";
import { PrivyClient } from "@privy-io/server-auth";

export const runtime = "nodejs";

const AUTH_SERVICE_URL = process.env.NEXT_PUBLIC_GC_AUTH_URL || "https://auth.graffiticode.org";
const AUTH_SERVICE_INTERNAL_API_KEY =
  process.env.AUTH_SERVICE_INTERNAL_API_KEY || process.env.INTERNAL_API_KEY || "";
const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID || "";
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET || "";

let privyClient: PrivyClient | null = null;
const getPrivyClient = () => {
  if (privyClient) return privyClient;
  if (!PRIVY_APP_ID || !PRIVY_APP_SECRET) {
    throw new Error("Privy server credentials not configured");
  }
  privyClient = new PrivyClient(PRIVY_APP_ID, PRIVY_APP_SECRET);
  return privyClient;
};

const extractEmail = (user: any): string | null => {
  if (typeof user?.email?.address === "string") return user.email.address;
  if (typeof user?.email === "string") return user.email;
  const linked = Array.isArray(user?.linkedAccounts) ? user.linkedAccounts : [];
  const emailAccount = linked.find((a: any) => a?.type === "email" && typeof a.address === "string");
  return emailAccount?.address ?? null;
};

// Asks the auth service to find the uid linked to this email AND mint a Firebase
// custom token for them (the auth service targets the graffiticode project and
// holds the signing permission this app's SA does not).
async function signInByEmail(email: string): Promise<{ uid: string; customToken: string } | null> {
  if (!AUTH_SERVICE_INTERNAL_API_KEY) {
    console.warn("[email-signin/resolve] auth-service internal key not configured; no match");
    return null;
  }
  const url = `${AUTH_SERVICE_URL.replace(/\/$/, "")}/linked-emails/internal/sign-in`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-API-Key": AUTH_SERVICE_INTERNAL_API_KEY,
    },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    console.warn("[email-signin/resolve] auth-service sign-in failed", res.status);
    return null;
  }
  const body = await res.json();
  if (body?.status !== "success") return null;
  if (!body.data?.matched) return null;
  const uid = body.data.uid;
  const customToken = body.data.firebaseCustomToken;
  if (!uid || !customToken) return null;
  return { uid, customToken };
}

export async function POST(req: NextRequest) {
  let privyAccessToken: string | undefined;
  try {
    const body = await req.json();
    privyAccessToken = body?.privyAccessToken;
  } catch {
    // fall through to validation below
  }
  if (typeof privyAccessToken !== "string" || !privyAccessToken) {
    return NextResponse.json({ matched: false, error: "privyAccessToken required" }, { status: 400 });
  }

  let email: string | null = null;
  try {
    const privy = getPrivyClient();
    const claims = await privy.verifyAuthToken(privyAccessToken);
    const user = await privy.getUser(claims.userId);
    email = extractEmail(user);
  } catch (err: any) {
    console.warn("[email-signin/resolve] Privy token verification failed:", err?.message);
    return NextResponse.json({ matched: false });
  }
  if (!email) {
    return NextResponse.json({ matched: false });
  }
  const normalizedEmail = email.trim().toLowerCase();

  let result: { uid: string; customToken: string } | null = null;
  try {
    result = await signInByEmail(normalizedEmail);
  } catch (err: any) {
    console.error("[email-signin/resolve] sign-in error:", err?.message);
    return NextResponse.json({ matched: false, email: normalizedEmail });
  }
  if (!result) {
    return NextResponse.json({ matched: false, email: normalizedEmail });
  }
  return NextResponse.json({ matched: true, customToken: result.customToken });
}
