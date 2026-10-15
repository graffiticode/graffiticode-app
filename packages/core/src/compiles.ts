// Moved from pages/api/resolvers.ts (Phase 1: untangle inside the console).
import { getApiTask } from "./lib/api.js";
import path from "path";
import { db } from "./db.js";
import { getItems } from "./items.js";
import { requireFullAccount } from "./errors.js";

export async function logCompile({ auth, units, id, timestamp, status, data }) {
  try {
    const [{ lang }] = await getApiTask({ id, auth });
    const path = `users/${auth.uid}/compiles/${id}`;
    data = JSON.parse(data);
    await db().doc(path).set({ id, timestamp, status, lang, data });

    // Item-based billing: compiles are free (iteration is included). Keep a
    // zero-unit audit record for history/telemetry, but never meter compiles or
    // touch the monthly item counter. Billing is driven by recordBillableItem.
    await db().collection("usage").add({
      userId: auth.uid,
      taskId: id,
      units: 0,
      createdAt: new Date(),
      timestamp,
      lang,
      type: "compile",
      status,
    });

    return JSON.stringify({ success: true });
  } catch (x) {
    console.log("logCompile()", "ERROR", x);
  }
}

export async function getTasks({ auth, lang, mark }) {
  requireFullAccount(auth, "history");
  try {
    // Get items from the items collection (primary source)
    const items = await getItems({ auth, lang, mark, client: 'console' });

    // Get taskIds from the taskIds collection (for backward compatibility)
    const taskIdsDocs = await db()
      .collection(`users/${auth.uid}/taskIds`)
      .where("lang", "==", lang)
      .where("mark", "==", mark)
      .get();

    // Create a set of IDs from items to avoid duplicates
    const itemIds = new Set(items.map((item) => item.taskId || item.id));

    // Process taskIds that aren't already in items and create items for them
    for (const doc of taskIdsDocs.docs) {
      const taskId = doc.id;
      const taskData = doc.data();

      if (!itemIds.has(taskId)) {
        // Create an item for this task
        try {
          const itemRef = db().collection(`users/${auth.uid}/items`).doc();
          const item = {
            id: itemRef.id,
            taskId: taskId,
            name: taskData.name || "unnamed",
            lang: taskData.lang,
            mark: taskData.mark || 1,
            help: taskData.help || "[]",
            isPublic: taskData.isPublic || false,
            created: taskData.created || Date.now(),
            updated: taskData.updated || taskData.created || Date.now(),
          };

          await itemRef.set(item);

          // Add the newly created item to our items list
          items.push({
            ...item,
            created: String(item.created),
            updated: String(item.updated),
          });

        } catch (error) {
          console.error(`Failed to create item for task ${taskId}:`, error);
        }
      }
    }

    // Mark all tasks in taskIds collection with mark 5 after loading them as items
    const allTaskIds = await db()
      .collection(`users/${auth.uid}/taskIds`)
      .where("lang", "==", lang)
      .where("mark", "==", mark)
      .get();

    const updatePromises = allTaskIds.docs.map((doc) =>
      db().doc(`users/${auth.uid}/taskIds/${doc.id}`).update({ mark: 5 }),
    );

    await Promise.all(updatePromises);

    // Convert items to tasks format
    const tasks = await Promise.all(
      items.map(async (item) => {
        return {
          id: item.taskId || item.id,
          lang: item.lang,
          help: item.help || "[]",
          isPublic: item.isPublic || false,
          taskId: item.taskId || item.id,
          created: item.created,
          name: item.name,
          mark: item.mark || 1,
        };
      }),
    );

    return tasks;
  } catch (x) {
    console.log("getTasks()", "ERROR", x);
  }
}

export async function compiles({ auth, lang, type }) {
  requireFullAccount(auth, "history");
  try {
    const compilesDocs = await db()
      .collection(`users/${auth.uid}/compiles`)
      .where("lang", "==", lang)
      .get();
    const data = [];
    compilesDocs.forEach((doc) => {
      data.push(doc.data());
    });
    return data;
  } catch (x) {
    console.log("compiles()", "ERROR", x);
  }
}
