import bent from "bent";
import { GraphQLClient, gql } from 'graphql-request';
import { postApiCompile } from "../../lib/api";

const buildRequestClient = async ({ token }) => {
  const client = new GraphQLClient("/api", {
    headers: {
      authorization: token,
    }
  });
  return client;
};

export const compile = async ({ user, id, data = {}, buildLayerCount = 0 }: { user: any; id: string; data?: any; buildLayerCount?: number }) => {
  try {
    // Preserve the head segment plus any build-time state layers
    // (planner-built upstreams). Runtime form state is the trailing
    // segment that gets stripped/replaced on each compile.
    const keep = 1 + Math.max(0, buildLayerCount);
    const segments = id.split("+");
    const hasFormData = Object.keys(data).length > 0;
    // When there's runtime formData, drop any trailing runtime-state
    // segment so the api server reposts the new state cleanly.
    // Otherwise preserve the full chain so a standalone compile uses
    // the build-time layers as `data`.
    const sliceTo = hasFormData ? Math.min(keep, segments.length) : segments.length;
    id = segments.slice(0, sliceTo).join("+");
    const accessToken = await user.getToken();
    const resp = await postApiCompile({ accessToken, id, data });
    return resp;
  } catch (x) {
    console.log(
      "swr/compile",
      "Error " + x.stack,
    );
  }
};

// The connection each connectable language's saves write through (system-wide
// per user), with the candidates it can be chosen from.
const CURRENT_CONNECTION_FIELDS = `
  lang backend connectionId explicit
  candidates { connectionId backend status label shared permissions { lang fn } expiresAt }
`;

export const loadCurrentConnections = async ({ user }: { user: any }) => {
  const client = await buildRequestClient({ token: await user.getToken() });
  const query = gql`
    query currentConnections {
      currentConnections { ${CURRENT_CONNECTION_FIELDS} }
    }
  `;
  return client.request(query).then((data: any) => data.currentConnections);
};

// connectionId null clears the explicit choice (a sole candidate is then used).
export const setCurrentConnection = async ({ user, lang, connectionId }: { user: any; lang: string; connectionId: string | null }) => {
  const client = await buildRequestClient({ token: await user.getToken() });
  const mutation = gql`
    mutation setCurrentConnection($lang: String!, $connectionId: String) {
      setCurrentConnection(lang: $lang, connectionId: $connectionId) { ${CURRENT_CONNECTION_FIELDS} }
    }
  `;
  return client.request(mutation, { lang, connectionId }).then((data: any) => data.setCurrentConnection);
};

const ITEM_CONNECTION_FIELDS = `
  id taskId connectionId publicationId publicationConnectionId publishedTaskId
  lastWrite { taskId connectionId status message at }
`;

// Writes the item's current version through the current connection again,
// under the same idempotency key as its save: never a second write.
export const retryItemWrite = async ({ user, id }: { user: any; id: string }) => {
  const client = await buildRequestClient({ token: await user.getToken() });
  const mutation = gql`
    mutation retryItemWrite($id: String!) {
      retryItemWrite(id: $id) { ${ITEM_CONNECTION_FIELDS} }
    }
  `;
  return client.request(mutation, { id }).then((data: any) => data.retryItemWrite);
};

// Compiles the item's current version again instead of using the cached
// result. Through a connection, it writes again (a fresh idempotency key).
export const recompileItem = async ({ user, id }: { user: any; id: string }) => {
  const client = await buildRequestClient({ token: await user.getToken() });
  const mutation = gql`
    mutation recompileItem($id: String!) {
      recompileItem(id: $id) { ${ITEM_CONNECTION_FIELDS} }
    }
  `;
  return client.request(mutation, { id }).then((data: any) => data.recompileItem);
};

export const republishItem = async ({ user, id }: { user: any; id: string }) => {
  const client = await buildRequestClient({ token: await user.getToken() });
  const mutation = gql`
    mutation republishItem($id: String!) {
      republishItem(id: $id) { ${ITEM_CONNECTION_FIELDS} }
    }
  `;
  return client.request(mutation, { id }).then((data: any) => data.republishItem);
};

// Connection management (delegated API permissions). The credential goes to
// policy, which passes it once to the broker; it is never returned.
const connectionMutation = async (user: any, mutation: string, variables: any, field: string) => {
  const client = await buildRequestClient({ token: await user.getToken() });
  return client.request(mutation, variables).then((data: any) => data[field]);
};

export const createConnection = ({ user, backend, label, key, secret }: { user: any; backend: string; label?: string | null; key: string; secret: string }) =>
  connectionMutation(user, gql`
    mutation createConnection($backend: String!, $label: String, $key: String!, $secret: String!) {
      createConnection(backend: $backend, label: $label, key: $key, secret: $secret) { connectionId backend status label }
    }
  `, { backend, label: label || null, key, secret }, "createConnection");

export const rotateConnection = ({ user, connectionId, key, secret }: { user: any; connectionId: string; key: string; secret: string }) =>
  connectionMutation(user, gql`
    mutation rotateConnection($connectionId: String!, $key: String!, $secret: String!) {
      rotateConnection(connectionId: $connectionId, key: $key, secret: $secret)
    }
  `, { connectionId, key, secret }, "rotateConnection");

export const disableConnection = ({ user, connectionId }: { user: any; connectionId: string }) =>
  connectionMutation(user, gql`
    mutation disableConnection($connectionId: String!) { disableConnection(connectionId: $connectionId) }
  `, { connectionId }, "disableConnection");

export const deleteConnection = ({ user, connectionId }: { user: any; connectionId: string }) =>
  connectionMutation(user, gql`
    mutation deleteConnection($connectionId: String!) { deleteConnection(connectionId: $connectionId) }
  `, { connectionId }, "deleteConnection");

export type Permission = { lang: string; fn: string };
export type GrantAccess = { permissions: Permission[]; expiresAt?: string | null };
const accessVars = ({ permissions, expiresAt }: GrantAccess) => ({ permissions, expiresAt: expiresAt || null });

// Names the recipient by email or by account ID: pass exactly one.
export const shareConnection = ({ user, connectionId, email = null, accountId = null, ...access }: { user: any; connectionId: string; email?: string | null; accountId?: string | null } & GrantAccess) =>
  connectionMutation(user, gql`
    mutation shareConnection($connectionId: String!, $email: String, $accountId: String, $permissions: [PermissionInput!]!, $expiresAt: String) {
      shareConnection(connectionId: $connectionId, email: $email, accountId: $accountId, permissions: $permissions, expiresAt: $expiresAt)
    }
  `, { connectionId, email, accountId, ...accessVars(access) }, "shareConnection");

export const updateConnectionGrant = ({ user, connectionId, grantId, ...access }: { user: any; connectionId: string; grantId: string } & GrantAccess) =>
  connectionMutation(user, gql`
    mutation updateConnectionGrant($connectionId: String!, $grantId: String!, $permissions: [PermissionInput!]!, $expiresAt: String) {
      updateConnectionGrant(connectionId: $connectionId, grantId: $grantId, permissions: $permissions, expiresAt: $expiresAt)
    }
  `, { connectionId, grantId, ...accessVars(access) }, "updateConnectionGrant");

export const revokeConnectionGrant = ({ user, connectionId, grantId }: { user: any; connectionId: string; grantId: string }) =>
  connectionMutation(user, gql`
    mutation revokeConnectionGrant($connectionId: String!, $grantId: String!) {
      revokeConnectionGrant(connectionId: $connectionId, grantId: $grantId)
    }
  `, { connectionId, grantId }, "revokeConnectionGrant");

export const leaveSharedConnection = ({ user, connectionId }: { user: any; connectionId: string }) =>
  connectionMutation(user, gql`
    mutation leaveSharedConnection($connectionId: String!) { leaveSharedConnection(connectionId: $connectionId) }
  `, { connectionId }, "leaveSharedConnection");

export const loadConnectionGrants = async ({ user, connectionId }: { user: any; connectionId: string }) => {
  const client = await buildRequestClient({ token: await user.getToken() });
  const query = gql`
    query connectionGrants($connectionId: String!) {
      connectionGrants(connectionId: $connectionId) { grantId recipient pending permissions { lang fn } expiresAt createdAt }
    }
  `;
  return client.request(query, { connectionId }).then((data: any) => data.connectionGrants);
};

export const loadShareableFunctions = async ({ user, connectionId }: { user: any; connectionId: string }) => {
  const client = await buildRequestClient({ token: await user.getToken() });
  const query = gql`
    query shareableFunctions($connectionId: String!) {
      shareableFunctions(connectionId: $connectionId) { lang fn kind }
    }
  `;
  return client.request(query, { connectionId }).then((data: any) => data.shareableFunctions);
};

export const loadConnectionFunctions = async ({ user, connectionId }: { user: any; connectionId: string }) => {
  const client = await buildRequestClient({ token: await user.getToken() });
  const query = gql`
    query connectionFunctions($connectionId: String!) {
      connectionFunctions(connectionId: $connectionId) { lang fn kind implicit delegable }
    }
  `;
  return client.request(query, { connectionId }).then((data: any) => data.connectionFunctions);
};

// null: everything.
export const setOwnerPermissions = ({ user, connectionId, permissions }: { user: any; connectionId: string; permissions: Permission[] | null }) =>
  connectionMutation(user, gql`
    mutation setOwnerPermissions($connectionId: String!, $permissions: [PermissionInput!]) {
      setOwnerPermissions(connectionId: $connectionId, permissions: $permissions)
    }
  `, { connectionId, permissions }, "setOwnerPermissions");

export const loadConnections = async ({ user }: { user: any }) => {
  const client = await buildRequestClient({ token: await user.getToken() });
  const query = gql`
    query connections {
      connections { connectionId backend status label system shared permissions { lang fn } expiresAt sharedBy { name shortId } ownerPermissions { lang fn } }
    }
  `;
  return client.request(query).then((data: any) => data.connections);
};

export const parse = async ({ user, lang, src, itemId }: { user: any; lang: string; src: string; itemId?: string }) => {
  const token = await user.getToken();
  const client = new GraphQLClient("/api", {
    headers: {
      authorization: token,
    }
  });
  const query = gql`
    query parse($lang: String!, $src: String!, $itemId: String) {
      parse(lang: $lang, src: $src, itemId: $itemId) {
        code
        errors { message from to }
      }
    }
  `;
  return client.request(query, { lang, src, itemId }).then(data => data.parse);
};

export const postTask = async ({ user, lang, code, item }: { user: any, lang: string, code: string, item?: string }) => {
  const query = gql`
    mutation post ($lang: String!, $code: String!, $ephemeral: Boolean!, $item: String) {
      postTask(lang: $lang, code: $code, ephemeral: $ephemeral, item: $item)
    }
  `;
  const token = await user.getToken();
  const client = new GraphQLClient("/api", {
    headers: {
      authorization: token,
    }
  });
  const ephemeral = true;
  return client.request(query, { lang, code, ephemeral, item }).then(data => data.postTask);
};



export const loadTasks = async ({ user, lang, mark }) => {
  // console.log(
  //   "loadTasks()",
  // );
  if (!user) {
    return {};
  }
  const token = await user.getToken();
  //const request = buildRequestClient({ token });
  const client = new GraphQLClient("/api", {
    headers: {
      authorization: token,
    }
  });
  const query = gql`
    query get($lang: String!, $mark: Int!) {
      tasks(lang: $lang, mark: $mark) {
        id
        lang,
        src
        help
        isPublic
        created
        name
        mark
      }
    }
  `;
  return client.request(query, { lang, mark }).then(data => data.tasks);
};

export const getData = async ({ user, id, connectionId = null }: { user: any; id: string; connectionId?: string | null }) => {
  // console.log(
  //   "getData()",
  //   "id=" + id,
  // );
  if (!user) {
    return {};
  }

  // Removed unused data parameter and associated logic that was causing issues
  const token = await user.getToken();
  const client = new GraphQLClient("/api", {
    headers: {
      authorization: token,
    }
  });
  const query = gql`
    query get($id: String!, $connectionId: String) {
      data(id: $id, connectionId: $connectionId)
    }
  `;
  return client.request(query, { id, connectionId }).then((data: any) => JSON.parse(data.data));
};

export const getSpec = async ({ user, id }) => {
  if (!user || !id) {
    return null;
  }
  const token = await user.getToken();
  const client = new GraphQLClient("/api", {
    headers: {
      authorization: token,
    }
  });
  const query = gql`
    query getSpec($id: String!) {
      spec(id: $id) {
        spec
        lang
        itemId
        coverage { checked missing }
      }
    }
  `;
  return client.request(query, { id }).then(data => data.spec);
};

export const countTasks = async ({ user, langs, mark }) => {
  // console.log(
  //   "countTasks()",
  // );
  if (!user) {
    return {};
  }
  const token = await user.getToken();
  const groups = await Promise.all(langs.map(lang => {
    return loadTasks({user, lang: lang.name.slice(1), mark});
  }));
  const counts = {};
  groups.forEach((group, index) => {
    counts[langs[index].name] = group.length;
  });
  return counts;
};

// The names of the user's items in a language (optionally one mark), without
// loading the items themselves.
export const loadItemNames = async ({ user, lang, mark = null }: { user: any; lang: string; mark?: number | null }): Promise<string[]> => {
  if (!user) {
    return [];
  }
  const client = await buildRequestClient({ token: await user.getToken() });
  const query = gql`
    query itemNames($lang: String!, $mark: Int) {
      itemNames(lang: $lang, mark: $mark)
    }
  `;
  return client.request(query, { lang, mark }).then((data: any) => data.itemNames);
};

export const countItems = async ({ user, langs }) => {
  if (!user) {
    return {};
  }
  // One aggregate request for every language, counted server-side across all
  // surfaces (console/mcp/front) with mark 5 (black) excluded. Listing each
  // language's items to count them stalled the server on every Tools load.
  const client = await buildRequestClient({ token: await user.getToken() });
  const query = gql`
    query itemCounts($langs: [String!]!) {
      itemCounts(langs: $langs) { lang count }
    }
  `;
  const ids = langs.map(lang => lang.name.slice(1));
  const rows = await client.request(query, { langs: ids }).then((data: any) => data.itemCounts);
  const counts = {};
  rows.forEach((row, index) => {
    counts[langs[index].name] = row.count;
  });
  return counts;
};

export const loadTaskVersions = async ({ user, lang, client: clientId, itemId, limit, startAfter }: { user: any; lang: string; client?: string; itemId?: string; limit?: number; startAfter?: string }) => {
  if (!user) {
    return [];
  }
  const token = await user.getToken();
  const client = new GraphQLClient("/api", {
    headers: {
      authorization: token,
    }
  });
  const query = gql`
    query loadTaskVersions($lang: String!, $client: String, $itemId: String, $limit: Int, $startAfter: String) {
      taskVersions(lang: $lang, client: $client, itemId: $itemId, limit: $limit, startAfter: $startAfter) {
        id
        itemId
        taskId
        lang
        langs
        name
        mark
        client
        source
        label
        createdAt
      }
    }
  `;
  // startAfter is the createdAt of the last row seen (epoch ms as a string), not a doc id.
  return client.request(query, { lang, client: clientId, itemId, limit, startAfter }).then(data => data.taskVersions);
};

export const getAccessToken = async ({ user }) => {
  if (!user) {
    return null;
  }
  return await user.getToken();
};

export const loadGraphiQL = async ({ user }) => {
  if (!user) {
    return {};
  }
  const token = await user.getToken();
  //const request = buildRequestClient({ token });
  const headers = {
    authorization: token,
    accept: "text/html",
  };
  const get = bent(location.origin, "GET", "string");
  const data = await get("/api", null, headers);
  return data.replace(/\n/g, "").slice(15);
};

/**
 * Generate code using the GraphQL API
 *
 * @param {Object} params - Parameters for code generation
 * @param {string} params.prompt - The code description or requirements
 * @param {string} [params.language] - Optional target programming language
 * @param {Object} [params.options] - Additional generation options
 * @returns {Promise<Object>} - Generated code and metadata
 */
export const loadItems = async ({ user, lang, mark, client: clientId }) => {
  if (!user) {
    return [];
  }
  const token = await user.getToken();
  const client = new GraphQLClient("/api", {
    headers: {
      authorization: token,
    }
  });
  const query = gql`
    query loadItems($lang: String!, $mark: Int, $client: String) {
      items(lang: $lang, mark: $mark, client: $client) {
        id
        name
        taskId
        lang
        mark
        help
        isPublic
        created
        updated
        sharedWith
        client
        upstreamLangs
        connectionId
        publicationId
        publicationConnectionId
        publishedTaskId
        lastWrite { taskId connectionId status message at }
      }
    }
  `;
  return client.request(query, { lang, mark, client: clientId }).then(data => data.items);
};

export const loadItemClientTags = async ({ user, lang }) => {
  if (!user) return [];
  const token = await user.getToken();
  const client = new GraphQLClient("/api", {
    headers: {
      authorization: token,
    }
  });
  const query = gql`
    query loadItemClientTags($lang: String!) {
      itemClientTags(lang: $lang)
    }
  `;
  return client.request(query, { lang }).then(data => data.itemClientTags || []);
};

export const createItem = async ({ user, lang, name, taskId, mark, help, isPublic, client: clientId, upstreamLangs }: { user: any; lang: string; name?: string; taskId?: string; mark?: number; help?: string; isPublic?: boolean; client?: string; upstreamLangs?: string[] }) => {
  if (!user) {
    return null;
  }
  const token = await user.getToken();
  const client = new GraphQLClient("/api", {
    headers: {
      authorization: token,
    }
  });
  const mutation = gql`
    mutation createItem($lang: String!, $name: String, $taskId: String, $mark: Int, $help: String, $isPublic: Boolean, $client: String, $upstreamLangs: [String!]) {
      createItem(lang: $lang, name: $name, taskId: $taskId, mark: $mark, help: $help, isPublic: $isPublic, client: $client, upstreamLangs: $upstreamLangs) {
        id
        name
        taskId
        lang
        mark
        help
        isPublic
        created
        updated
        client
        upstreamLangs
        connectionId
        lastWrite { taskId connectionId status message at }
      }
    }
  `;
  return client.request(mutation, { lang, name, taskId, mark, help, isPublic, client: clientId, upstreamLangs }).then(data => data.createItem);
};

export const updateItem = async ({ user, id, name, taskId, mark, help, isPublic, client: clientId, upstreamLangs, source, label }: { user: any; id: string; name?: string; taskId?: string; mark?: number; help?: string; isPublic?: boolean; client?: string; upstreamLangs?: string[]; source?: string; label?: string }) => {
  if (!user) {
    return null;
  }
  const token = await user.getToken();
  const client = new GraphQLClient("/api", {
    headers: {
      authorization: token,
    }
  });
  const mutation = gql`
    mutation updateItem($id: String!, $name: String, $taskId: String, $mark: Int, $help: String, $isPublic: Boolean, $client: String, $upstreamLangs: [String!], $source: String, $label: String) {
      updateItem(id: $id, name: $name, taskId: $taskId, mark: $mark, help: $help, isPublic: $isPublic, client: $client, upstreamLangs: $upstreamLangs, source: $source, label: $label) {
        id
        name
        taskId
        lang
        mark
        help
        isPublic
        created
        updated
        client
        upstreamLangs
        connectionId
        publicationId
        publicationConnectionId
        publishedTaskId
        lastWrite { taskId connectionId status message at }
      }
    }
  `;
  return client.request(mutation, { id, name, taskId, mark, help, isPublic, client: clientId, upstreamLangs, source, label }).then(data => data.updateItem);
};

export const shareItem = async ({ user, itemId, targetUserId }) => {
  if (!user) {
    return null;
  }
  const token = await user.getToken();
  const client = new GraphQLClient("/api", {
    headers: {
      authorization: token,
    }
  });
  const mutation = gql`
    mutation shareItem($itemId: String!, $targetUserId: String!) {
      shareItem(itemId: $itemId, targetUserId: $targetUserId) {
        success
        message
        newItemId
      }
    }
  `;
  return client.request(mutation, { itemId, targetUserId }).then(data => data.shareItem);
};

// An account found to share with. Never carries an email.
export type AccountMatch = { accountId: string; name: string; shortId: string; matchedBy: "email" | "name" | "id" };

// Accounts matching an exact linked email, profile name or account ID (at
// least 3 characters; see src/lib/account-lookup.ts). Throws on failure.
export const findAccounts = async ({ user, query }: { user: any; query: string }): Promise<AccountMatch[]> => {
  const token = await user.getToken();
  const client = new GraphQLClient("/api", { headers: { authorization: token } });
  const data: any = await client.request(gql`
    query findAccounts($query: String!) {
      findAccounts(query: $query) { accountId name shortId matchedBy }
    }
  `, { query });
  return data.findAccounts;
};

export const getTask = async ({ user, id }) => {
  if (!user || !id) {
    return null;
  }
  const token = await user.getToken();
  const client = new GraphQLClient("/api", {
    headers: {
      authorization: token,
    }
  });
  const query = gql`
    query getTask($id: String!) {
      task(id: $id) {
        id
        lang
        langs
        code
        src
      }
    }
  `;
  return client.request(query, { id }).then(data => data.task);
};

export const getTaskLangs = async ({ user, id }) => {
  if (!user || !id) {
    return null;
  }
  const token = await user.getToken();
  const client = new GraphQLClient("/api", {
    headers: {
      authorization: token,
    }
  });
  const query = gql`
    query getTaskLangs($id: String!) {
      task(id: $id) {
        id
        lang
        langs
      }
    }
  `;
  return client.request(query, { id }).then(data => data.task);
};

export const getItem = async ({ user, id }) => {
  if (!user || !id) {
    return null;
  }
  const token = await user.getToken();
  const client = new GraphQLClient("/api", {
    headers: {
      authorization: token,
    }
  });
  const query = gql`
    query getItem($id: String!) {
      item(id: $id) {
        id
        name
        taskId
        lang
        mark
        help
        isPublic
        created
        updated
        client
        upstreamLangs
      }
    }
  `;
  return client.request(query, { id }).then(data => data.item);
};

/**
 * What a data model may weigh before it stops travelling with the request.
 *
 * The server renders at most 6KB of it into the prompt, so a cap a little above
 * that loses nothing it would have used — while keeping a large compiled item
 * (a Learnosity record runs to tens of KB) from padding every generation request
 * toward the API route's 1MB body limit, where it would fail the generation
 * outright rather than merely decorate it. Context worth having here is the kind
 * the SOURCE cannot carry, and that kind is small.
 */
const MAX_CURRENT_DATA_CHARS = 8000;

export const generateCode = async ({ user, prompt, language, options, currentSrc, currentData = null, conversationSummary = null, itemId = undefined }) => {
  if (!user) {
    return {};
  }
  const token = await user.getToken();
  const client = new GraphQLClient("/api", {
    headers: {
      authorization: token,
    }
  });
  const query = gql`
    mutation GenerateCode($prompt: String!, $language: String!, $options: CodeGenerationOptions, $currentSrc: String, $currentData: String, $conversationSummary: ConversationSummaryInput, $itemId: String) {
      generateCode(prompt: $prompt, language: $language, options: $options, currentSrc: $currentSrc, currentData: $currentData, conversationSummary: $conversationSummary, itemId: $itemId) {
        src
        taskId
        description
        language
        model
        provider
        tier
        usage {
          input_tokens
          output_tokens
        }
        errors {
          message
          from
          to
        }
        upstreamLangs
      }
    }
  `;

  // The compiled record the editor already fetched for its Data tab, serialized
  // for transport (the schema has no JSON scalar). Sent only on an EDIT: on a
  // fresh create there is no current code for it to describe, and whatever the
  // Data tab is still showing belongs to the previous item.
  let currentDataJson: string | null = null;
  if (currentSrc && currentData && Object.keys(currentData).length > 0) {
    try {
      const serialized = JSON.stringify(currentData);
      if (serialized && serialized.length <= MAX_CURRENT_DATA_CHARS) {
        currentDataJson = serialized;
      }
    } catch {
      currentDataJson = null;
    }
  }

  // Prepare the variables
  const variables = {
    prompt,
    language,
    options,
    currentSrc,
    currentData: currentDataJson,
    conversationSummary,
    itemId,
  };

  try {
    const result = await client.request(query, variables);
    console.log(
      "fetchers/generateCode()",
      "result=" + JSON.stringify(result, null, 2),
    );
    return result.generateCode;
  } catch (error) {
    console.error("Error in generateCode fetcher:", error);
    throw new Error(`Failed to generate code: ${error.message}`);
  }
};
