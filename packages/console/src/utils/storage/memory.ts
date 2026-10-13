import { decodeID, encodeID } from "../id";
import { NotFoundError } from "../errors/http";

const buildObjectToId = ({ idsByObject, objectsById }) => obj => {
  if (obj === null) {
    return 0;
  }
  const key = JSON.stringify(obj);
  if (!idsByObject.has(key)) {
    const newId = objectsById.size + 1;
    idsByObject.set(key, newId);
    objectsById.set(newId, obj);
  }
  return idsByObject.get(key);
};

const buildObjectFromId = ({ objectsById }) => id => {
  return objectsById.get(id);
};

const buildTaskCreate = ({ objectToId, aclsById }) => async ({ auth, task }) => {
  const langId = task.lang;
  const codeId = objectToId(task.code);
  const id = encodeID([langId, codeId, 0]);

  if (!aclsById.has(id)) {
    aclsById.set(id, { public: false, uids: new Set() });
  }
  const acls = aclsById.get(id);
  if (auth) {
    acls.uids.add(auth.uid);
  } else {
    acls.public = true;
  }
  return id;
};

const buildCheckAuth = ({ aclsById }) => ({ id, auth }) => {
  if (!aclsById.has(id)) {
    return;
  }
  const acls = aclsById.get(id);
  if (acls.public) {
    return;
  }
  if (!auth) {
    throw new NotFoundError('Authentication not found');
  }
  if (acls.uids.has(auth.uid)) {
    return;
  }
  throw new NotFoundError('Access denied');
};

const buildTaskGet = ({ objectFromId, aclsById }) => {
  const checkAuth = buildCheckAuth({ aclsById });
  return async ({ id, auth }) => {
    try {
      const tasks = [];
      let ids = decodeID(id);
      while (ids.length > 2) {
        const [langId, codeId, ...dataIds] = ids;
        const lang = langId.toString();
        const code = objectFromId(codeId);
        if (!code) {
          throw new NotFoundError('Code not found');
        }

        const subTaskId = encodeID([langId, codeId, 0]);
        checkAuth({ id: subTaskId, auth });

        tasks.push({ lang, code });

        ids = dataIds;
      }
      return tasks;
    } catch (x) {
      console.log("buildTaskGet() error=" + x.stack);
      return [];
    }
  };
};

const appendIds = (id, ...otherIds) => [id, ...otherIds].join("+");

export const buildMemoryTaskDao = () => {
  const aclsById = new Map();
  const idsByObject = new Map([[JSON.stringify({}), 1]]);
  const objectsById = new Map([[1, {}]]);
  const objectToId = buildObjectToId({ idsByObject, objectsById });
  const objectFromId = buildObjectFromId({ objectsById });
  const create = buildTaskCreate({ objectToId, aclsById });
  const get = buildTaskGet({ objectFromId, aclsById });
  return { create, get, appendIds };
};
