import { NextRequest, NextResponse } from "next/server";
import { getFirestore } from "@/server/db";
import { authFromRequest } from "@/server/request-auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ uid: string }> }) {
  const { uid } = await params;
  const auth = await authFromRequest(req);
  if (!auth || auth.uid !== uid) {
    return new NextResponse(null, { status: 403 });
  }
  try {
    const db = getFirestore();
    const doc = await db.collection("users").doc(uid).get();
    if (!doc.exists) {
      return new NextResponse(null, { status: 404 });
    }
    return NextResponse.json(doc.data());
  } catch (err) {
    console.error("GET /api/user error:", err);
    return new NextResponse(null, { status: 400 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ uid: string }> }) {
  const { uid } = await params;
  const auth = await authFromRequest(req);
  if (!auth || auth.uid !== uid) {
    return new NextResponse(null, { status: 403 });
  }
  try {
    const body = await req.json();
    const db = getFirestore();
    await db.collection("users").doc(uid).set(
      {
        ...body,
        updated: new Date().toISOString(),
      },
      { merge: true },
    );
    return new NextResponse(null, { status: 200 });
  } catch (err) {
    console.error("PUT /api/user error:", err);
    return new NextResponse(null, { status: 400 });
  }
}
