// POST /workspaces (a free-plan workspace) and GET /me (who you are and what
// you have left).
import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { mintSessionToken } from "@graffiticode-app/core/lib/free-plan-session-token";
import { deriveSessionNamespace } from "@graffiticode-app/core/lib/free-plan-context";
import { checkItemCreateAllowed } from "@graffiticode-app/core/lib/usage-service";
import { getPlan } from "@graffiticode-app/core/lib/plans-config";
import { freePlanLanguageIds } from "@graffiticode-app/core/lib/languages";
import { FREE_PLAN_ITEM_TTL_MS } from "@graffiticode-app/core/lib/free-plan-context";
import { db } from "@graffiticode-app/core/db";
import { callerFor } from "../auth.js";
import { languageId } from "../http.js";

// A workspace token lasts as long as the session token MCP mints (48h).
const WORKSPACE_TTL_MS = 48 * 60 * 60_000;
const SIGNUP_URL = "https://graffiticode.org/signup";

export function accountRoutes(app: Hono) {
  app.post("/workspaces", async (c) => {
    const uuid = randomUUID();
    const workspace = await mintSessionToken({ sessionNamespace: deriveSessionNamespace(uuid), sessionUuid: uuid });
    c.header("Cache-Control", "no-store");
    return c.json({
      workspace,
      expires_at: new Date(Date.now() + WORKSPACE_TTL_MS).toISOString(),
      usage: "Send it as `X-Graffiticode-Workspace` on every request.",
    }, 201);
  });

  app.get("/me", async (c) => {
    const caller = await callerFor(c);
    const auth = await caller.principal();
    c.header("Cache-Control", "no-store");
    if (auth.freePlan) {
      return c.json({
        account: "free_plan",
        free_plan: {
          item_ttl_hours: Math.round(FREE_PLAN_ITEM_TTL_MS / 3_600_000),
          languages: freePlanLanguageIds().map(languageId),
          signup_url: SIGNUP_URL,
        },
      });
    }
    const [gate, user] = await Promise.all([
      checkItemCreateAllowed(auth.uid, { skipSelfHeal: true, skipSubscriptionRepair: true }),
      db().doc(`users/${auth.uid}`).get(),
    ]);
    const plan = getPlan(user.data()?.subscription?.plan);
    return c.json({
      account: "user",
      plan: { id: plan.id, name: plan.displayName },
      usage: {
        items_this_period: gate.currentUsage ?? 0,
        included_items: gate.includedItems ?? null,
        available_items: Number.isFinite(gate.totalAvailable) ? gate.totalAvailable : null,
        period_ends_at: gate.periodEnd ? gate.periodEnd.toISOString() : null,
      },
    });
  });
}
