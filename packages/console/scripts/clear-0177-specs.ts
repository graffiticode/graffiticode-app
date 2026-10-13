/**
 * One-off: drop every cached L0177 spec so the next get_spec regenerates.
 *
 * The cache validates on {taskId, lang, model, version} — none of which move when a DIALECT's
 * prompt assets change, so a spec-directive or instructions edit leaves stale entries that would
 * be served indefinitely. SPEC_CACHE_VERSION is the global lever; this is the scoped one, for when
 * only one dialect moved and bumping the version would make every other language regenerate too.
 */
import "./eval-env";
import admin from "firebase-admin";
import { getCredentialsForApiKey } from "../src/lib/api-credentials";
import { getFirestore } from "../src/utils/db";

const ACCOUNTS = ["EVAL"];

(async () => {
  const db = getFirestore();
  const { uid: evalUid } = await getCredentialsForApiKey(process.env.EVAL_API_KEY!) as any;
  let total = 0;
  for (const a of ACCOUNTS) {
    const uid = a === "EVAL" ? evalUid : a;
    const snap = await db.collection(`users/${uid}/items`).where("lang", "==", "0177").get();
    const cached = snap.docs.filter(d => (d.data() as any)?.spec?.text);
    if (!cached.length) { console.log(`${a.slice(0, 6)}: none`); continue; }
    const batch = db.batch();
    for (const d of cached) batch.update(d.ref, { spec: admin.firestore.FieldValue.delete() });
    await batch.commit();
    total += cached.length;
    console.log(`${a.slice(0, 6)}: cleared ${cached.length}`);
  }
  // Verify, rather than trust the write.
  let left = 0;
  for (const a of ACCOUNTS) {
    const uid = a === "EVAL" ? evalUid : a;
    const snap = await db.collection(`users/${uid}/items`).where("lang", "==", "0177").get();
    left += snap.docs.filter(d => (d.data() as any)?.spec?.text).length;
  }
  console.log(`cleared ${total}, remaining ${left} (expect 0)`);
  process.exit(left === 0 ? 0 : 1);
})();
