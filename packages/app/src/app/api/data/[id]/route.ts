import { NextRequest, NextResponse } from "next/server";
import { authFromRequest } from "@/server/request-auth";
import { resolveFormTarget } from "@/server/resolvers";
import { getData } from "@/server/api";

export const runtime = "nodejs";

// Debug endpoint: returns the compiled data model that the form view at
// /form/{id} renders from. Accepts an item id or a task id (resolved the same
// way as /form). Auth comes from the Authorization header or an ?access_token=
// query param so it works both from the signed-in app and from a plain GET.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authFromRequest(req);
  const token = auth?.token ?? req.nextUrl.searchParams.get("access_token") ?? undefined;
  const target = await resolveFormTarget({ auth, id });
  try {
    const data = await getData({ accessToken: token, id: target.taskId });
    return NextResponse.json({
      id,
      itemId: target.itemId ?? null,
      taskId: target.taskId,
      data,
    });
  } catch (err: any) {
    console.error("[api/data] failed", target.taskId, err?.message);
    return NextResponse.json(
      { error: "failed to get data", taskId: target.taskId },
      { status: 502 },
    );
  }
}
