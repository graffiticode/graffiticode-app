import admin from "firebase-admin";
import { readFileSync } from "fs";

const creds = JSON.parse(readFileSync(process.env.GRAFFITICODE_APP_CREDENTIALS || "", "utf8"));
admin.initializeApp({ credential: admin.credential.cert(creds) });
const db = admin.firestore();

const EVAL_UID = "2c9d72e315fbafb128011bc32739666c7e6e7eb9";

async function main() {
  // Get all unique langs in training_examples
  const teSnap = await db.collection("training_examples").get();
  const teLangs = new Map<string, { count: number; hasItemId: boolean; sourcePath: string | null }>();

  teSnap.docs.forEach(d => {
    const lang = d.data().lang;
    const hasItemId = Boolean(d.data().item_id);
    const sourcePath = d.data().sourcePath;
    if (!teLangs.has(lang)) {
      teLangs.set(lang, { count: 0, hasItemId: false, sourcePath: null });
    }
    const entry = teLangs.get(lang)!;
    entry.count++;
    if (hasItemId) entry.hasItemId = true;
    if (sourcePath && !entry.sourcePath) entry.sourcePath = sourcePath;
  });

  // Check which have items
  for (const [lang, info] of [...teLangs.entries()].sort()) {
    const itemsSnap = await db.collection("users").doc(EVAL_UID).collection("items")
      .where("lang", "==", lang).limit(1).get();
    const hasItems = itemsSnap.size > 0;
    const path = hasItems ? "items" : (info.sourcePath ? "markdown" : "unknown");
    const file = info.sourcePath ? info.sourcePath.split("/").pop() : "";
    console.log(`L${lang}: ${info.count} examples, path=${path}${file ? ` (${file})` : ""}`);
  }
}

main().catch(console.error);
