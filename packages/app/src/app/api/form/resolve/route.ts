import { NextRequest, NextResponse } from "next/server";
import { authFromRequest } from "@/server/request-auth";
import { resolveFormTarget, evaluateAccess } from "@/server/resolvers";
import { logArtifactView } from "@/server/events";

export const runtime = "nodejs";

// Resolves a /form/{id} segment to a renderable task id and decides access.
// The viewer's token (if any) is forwarded so api-store access control (public
// flag + acls + ownership) is enforced authoritatively by api.graffiticode.org.
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  const auth = await authFromRequest(req);
  const target = await resolveFormTarget({ auth, id });
  // Access is governed by the head task; the appended "+data" segments are the
  // viewer's own runtime state and aren't independently GET-able from /task, so
  // checking the full chain would falsely 404. The full chain is still rendered.
  const headId = target.taskId.split("+")[0];
  const access = await evaluateAccess({ viewerAuth: auth, taskId: headId });

  console.log("[form/resolve]", {
    id,
    authed: !!auth,
    uid: auth?.uid ?? null,
    resolvedTaskId: target.taskId,
    accessCheckedId: headId,
    viaItem: !!target.itemId,
    allowed: access.allowed,
    reason: access.allowed ? null : access.reason,
  });

  // Funnel signal: an artifact page was OPENED — one event per page view, not
  // one per resolve. `item` prefers the resolved free-plan item doc id (what
  // view_url links to, so the report can join it to a session); falls back to
  // the raw URL id for a rare raw-task direct link.
  //
  // Gated on `view=1`, which the page sends only on its first resolve. This
  // route is polled every ~8s for item-backed forms, so emitting on every call
  // made "views" a function of how long a tab stayed open: one page left up for
  // an hour produced ~400 events, and a week with 8 items read as 7,369 views.
  // The previous note here assumed "the report dedups by session" — only
  // scripts/mcp-funnel-report.ts does, by joining item -> session. The console's
  // hourly digest counts raw events, so the inflation was live.
  if (req.nextUrl.searchParams.get("view") === "1") {
    logArtifactView({ item: target.itemId ?? id, authed: !!auth, allowed: access.allowed });
  }

  if (access.allowed) {
    return NextResponse.json({
      allowed: true,
      taskId: target.taskId,
      itemId: target.itemId ?? null,
    });
  }

  // When we resolved a real item, the form provably exists, so a denial means
  // "you can't see this" — never "no such form". Force "locked" (which the UI
  // turns into a sign-in / switch-account prompt) instead of the dead-end 404.
  // This matters because the api returns 404 for unauthenticated reads of a
  // private task, which evaluateAccess would otherwise surface as "not-found".
  const reason = target.itemId ? "locked" : access.reason;
  const owner = access.owner ?? (target.ownerUid ? { uid: target.ownerUid } : null);
  return NextResponse.json({
    allowed: false,
    taskId: target.taskId,
    reason,
    owner,
    detail: access.detail ?? null,
  });
}
