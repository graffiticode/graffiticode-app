import { buildMemoryTaskDao } from "./memory";
import { buildFirestoreTaskDao } from "./firestore";

const buildCreate = ({ cache }) => ({ type = "memory" } = {}) => {
  if (!cache.has(type)) {
    let taskDao;
    if (type === "memory") {
      taskDao = buildMemoryTaskDao();
    } else if (type === "firestore") {
      taskDao = buildFirestoreTaskDao();
    } else {
      throw new Error(`no TaskDao with type ${type}`);
    }
    cache.set(type, taskDao);
  }
  return cache.get(type);
};

export const buildTaskDaoFactory = () => {
  const cache = new Map();
  const create = buildCreate({ cache });
  return { create };
};
