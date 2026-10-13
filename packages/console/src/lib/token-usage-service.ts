import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { TokenUsage } from "./llm-generation-service";

export type Env = "prod" | "local";

/**
 * Which environment produced this record.
 *
 * Local development and production write to the SAME prod Firestore, and until
 * this field existed nothing told them apart — which is how a cost-per-item
 * figure came out 2-3x too high, with a developer's key billing $63 against the
 * deployed key's $26 in one window.
 *
 * Prod is the DEFAULT, so nothing has to be configured on Cloud Run. We only
 * step down to "local" on a positive signal that this is a developer's process.
 * Defaulting the other way would risk labelling production spend as local and
 * silently dropping it from the report; failing this way round merely lets some
 * dev spend through, which is exactly the status quo it replaces.
 *
 * `GC_TELEMETRY_ENV` overrides both signals — needed for the one ambiguous case,
 * a local `npm run start`, which sets NODE_ENV=production with no K_SERVICE.
 */
export function currentEnv(): Env {
  const override = process.env.GC_TELEMETRY_ENV;
  if (override === "prod" || override === "local") return override;
  if (process.env.K_SERVICE) return "prod"; // Cloud Run injects this; nothing to set
  if (process.env.NODE_ENV !== "production") return "local"; // next dev, tsx scripts
  return "prod";
}

export type Stage =
  | "code_gen"
  | "repair"
  | "route_scope_gate"
  | "route_rescope"
  | "compose_plan"
  | "compose_split"
  | "spec_gen"
  | "judge";

interface RecordTokenUsageArgs {
  auth: { uid: string };
  rid: string;
  stage: Stage;
  itemId: string | null;
  generatedTaskId?: string | null;
  lang?: string | null;
  provider: "anthropic" | "openai";
  model: string;
  tier?: string | null;
  usage: TokenUsage;
  /**
   * Did the work this usage paid for succeed?
   *
   * Until this existed only successes were recorded at all, so a request that
   * failed repeatedly left no trace and every cost report understated real
   * spend by exactly the failures. Records written before this field carry no
   * `outcome` — a consumer that wants successes only must treat MISSING as
   * success, not filter on equality, or it silently drops all history.
   */
  outcome?: "success" | "failed";
  extra?: Record<string, unknown>;
}

interface BackfillArgs {
  auth: { uid: string };
  rid: string;
  itemId: string;
}

const db = getFirestore();

export async function recordTokenUsage({
  auth,
  rid,
  stage,
  itemId,
  generatedTaskId,
  lang,
  provider,
  model,
  tier,
  usage,
  outcome = "success",
  extra,
}: RecordTokenUsageArgs): Promise<void> {
  // No-op if no tokens spent (including cache reads, which bill at 0.1×)
  if (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens ===
    0
  ) {
    return;
  }

  try {
    const now = new Date();
    const doc = {
      userId: auth.uid,
      taskId: rid, // Pre-existing field name; holds the request id
      rid,
      itemId: itemId ?? null,
      generatedTaskId: generatedTaskId ?? null,
      stage,
      units: 0, // Always 0 for telemetry-only docs (never billed)
      createdAt: Timestamp.now(),
      timestamp: now.toISOString(),
      lang: lang ?? null,
      type: "ai_generation",
      outcome,
      env: currentEnv(),
      provider,
      tier: tier ?? null,
      model,
      tokens: {
        input: usage.inputTokens,
        output: usage.outputTokens,
        total: usage.inputTokens + usage.outputTokens,
        cacheCreation: usage.cacheCreationInputTokens,
        cacheRead: usage.cacheReadInputTokens,
        reasoning: usage.reasoningTokens,
      },
      ...extra,
    };

    // Write flat log
    await db.collection("usage").add(doc);

    // Write/update item-doc rollup if itemId is known. Failed generations are
    // deliberately excluded: the flat log carries them for cost reporting, but
    // an item's own rollup should describe what producing THAT item cost.
    if (itemId && outcome === "success") {
      await updateItemTokenUsage(auth.uid, itemId, usage, model, stage);
    }
  } catch (error) {
    console.error("[token-usage-service] Failed to record token usage:", error);
    // Never throw — telemetry failures should not fail the generation
  }
}

async function updateItemTokenUsage(
  uid: string,
  itemId: string,
  usage: TokenUsage,
  model: string,
  stage: Stage
): Promise<void> {
  try {
    const itemRef = db.collection(`users/${uid}/items`).doc(itemId);

    // Use set with merge: true to create the doc if absent (needed for items created via
    // generation, where the doc ref is allocated before the doc exists). Nested objects inside
    // a map are not parsed for dots, so model ids like "gpt-5.6-terra" work as literal keys.
    await itemRef.set(
      {
        tokenUsage: {
          totals: {
            input: FieldValue.increment(usage.inputTokens),
            output: FieldValue.increment(usage.outputTokens),
            cacheCreation: FieldValue.increment(usage.cacheCreationInputTokens),
            cacheRead: FieldValue.increment(usage.cacheReadInputTokens),
          },
          byModel: {
            [model]: {
              input: FieldValue.increment(usage.inputTokens),
              output: FieldValue.increment(usage.outputTokens),
              cacheCreation: FieldValue.increment(usage.cacheCreationInputTokens),
              cacheRead: FieldValue.increment(usage.cacheReadInputTokens),
            },
          },
          byStage: {
            [stage]: {
              input: FieldValue.increment(usage.inputTokens),
              output: FieldValue.increment(usage.outputTokens),
              cacheCreation: FieldValue.increment(usage.cacheCreationInputTokens),
              cacheRead: FieldValue.increment(usage.cacheReadInputTokens),
            },
          },
          updatedAt: Date.now(),
        },
      },
      { merge: true }
    );
  } catch (error) {
    // Swallow not-found (item deleted mid-flight) and other errors
    if ((error as any)?.code !== "not-found") {
      console.error("[token-usage-service] Failed to update item token usage:", error);
    }
  }
}

export async function backfillTokenUsageItemId({
  auth,
  rid,
  itemId,
}: BackfillArgs): Promise<void> {
  try {
    // Query for pre-item usage docs with this rid that haven't been attributed yet
    const snapshot = await db
      .collection("usage")
      .where("userId", "==", auth.uid)
      .where("rid", "==", rid)
      .where("itemId", "==", null)
      .get();

    if (snapshot.empty) {
      return;
    }

    // Update each doc to set itemId and roll up its tokens to the item
    for (const docSnap of snapshot.docs) {
      const doc = docSnap.data();
      const usage: TokenUsage = {
        inputTokens: doc.tokens?.input ?? 0,
        outputTokens: doc.tokens?.output ?? 0,
        cacheCreationInputTokens: doc.tokens?.cacheCreation ?? 0,
        cacheReadInputTokens: doc.tokens?.cacheRead ?? 0,
        reasoningTokens: doc.tokens?.reasoning ?? 0,
      };
      const model = doc.model as string;
      const stage = doc.stage as Stage;

      // Update the usage doc to link it to the item
      await docSnap.ref.update({ itemId });

      // Apply the rollup to the item
      await updateItemTokenUsage(auth.uid, itemId, usage, model, stage);
    }
  } catch (error) {
    console.error("[token-usage-service] Failed to backfill token usage:", error);
    // Don't throw — this runs after item creation, so it shouldn't block that path
  }
}
