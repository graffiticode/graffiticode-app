import { NextRequest, NextResponse } from "next/server";
import { postApiCompile } from "@/server/api";
import { authFromRequest } from "@/server/request-auth";

export const runtime = "nodejs";

// Mints a new data task from runtime form state. The form harness POSTs the
// current task id plus the emitted state; binding the data via /compile yields
// a chained task id that captures the new state, which the client then writes
// into the location bar. No console item doc is created — items are console-only.
export async function POST(req: NextRequest) {
  const auth = await authFromRequest(req);
  let id: string | undefined;
  let data: any;
  try {
    const body = await req.json();
    id = body?.id;
    data = body?.data;
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  try {
    const resp = await postApiCompile({ accessToken: auth?.token, id, data });
    const newId = resp?.id ?? resp?.data?.id;
    if (!newId) {
      return NextResponse.json({ error: "no task id returned" }, { status: 502 });
    }
    return NextResponse.json({ id: newId });
  } catch (err: any) {
    console.error("POST /api/data-task failed:", err);
    return NextResponse.json({ error: "compile failed" }, { status: 502 });
  }
}
