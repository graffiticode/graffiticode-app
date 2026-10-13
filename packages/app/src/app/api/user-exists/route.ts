import { NextRequest, NextResponse } from "next/server";
import { getFirestore } from "@/server/db";

export const runtime = "nodejs";

const AUTH_SERVICE_URL = process.env.NEXT_PUBLIC_GC_AUTH_URL || "https://auth.graffiticode.org";
const AUTH_SERVICE_INTERNAL_API_KEY =
  process.env.AUTH_SERVICE_INTERNAL_API_KEY || process.env.INTERNAL_API_KEY || "";

const HEX = /^[0-9a-fA-F]+$/;

// Wallet sign-in creates the Firebase user in the `graffiticode` project, but
// the admin SDK here targets `graffiticode-app`, so ask the auth service (which
// runs in the right project). Fall back to a Firestore presence check when the
// internal key isn't configured (local dev).
async function lookupAuthService(address: string): Promise<boolean | null> {
  if (!AUTH_SERVICE_INTERNAL_API_KEY) return null;
  const url = `${AUTH_SERVICE_URL.replace(/\/$/, "")}/authenticate/ethereum/internal/exists/${encodeURIComponent(address)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { "X-Internal-API-Key": AUTH_SERVICE_INTERNAL_API_KEY },
  });
  if (!res.ok) {
    console.warn("[user-exists] auth-service lookup failed", res.status);
    return null;
  }
  const body = await res.json();
  if (body?.status !== "success") return null;
  return !!body.data?.exists;
}

async function lookupFirestore(uid: string): Promise<boolean> {
  const db = getFirestore();
  const [userDoc, itemsSnap, taskIdsSnap] = await Promise.all([
    db.collection("users").doc(uid).get(),
    db.collection(`users/${uid}/items`).limit(1).get(),
    db.collection(`users/${uid}/taskIds`).limit(1).get(),
  ]);
  return userDoc.exists || !itemsSnap.empty || !taskIdsSnap.empty;
}

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address");
  if (!address) {
    return NextResponse.json({ error: "address required" }, { status: 400 });
  }
  const raw = address.replace(/^0x/i, "");
  if (!HEX.test(raw)) {
    return NextResponse.json({ error: "invalid address" }, { status: 400 });
  }
  const uid = raw.toLowerCase();
  try {
    const authResult = await lookupAuthService(raw);
    if (authResult !== null) {
      console.log("[user-exists] via auth-service", { address: raw, exists: authResult });
      return NextResponse.json({ exists: authResult });
    }
    const exists = await lookupFirestore(uid);
    console.log("[user-exists] via firestore fallback", {
      address: raw,
      hasInternalKey: !!AUTH_SERVICE_INTERNAL_API_KEY,
      authUrl: AUTH_SERVICE_URL,
      exists,
    });
    return NextResponse.json({ exists });
  } catch (err) {
    console.error("[user-exists] lookup failed:", err);
    return NextResponse.json({ error: "lookup failed" }, { status: 500 });
  }
}
