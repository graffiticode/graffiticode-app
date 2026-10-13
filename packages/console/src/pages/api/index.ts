import { makeExecutableSchema } from "@graphql-tools/schema";
import { generateCodeForRequest } from "../../lib/code-generation/generate-for-request";
import {
  getGraphQLParameters,
  processRequest,
  sendResult,
  shouldRenderGraphiQL,
  renderGraphiQL,
} from "graphql-helix";
import {
  compiles,
  logCompile,
  getTasks,
  getTaskVersions,
  getTask,
  postTask,
  getData,
  createItem,
  updateItem,
  retryItemWrite,
  recompileItem,
  republishItem,
  getItems,
  countItems,
  getItemNames,
  getItem,
  getSpec,
  setItemGenerationStatus,
  getItemClientTags,
  shareItem,
  parseCode,
  claimFreePlanSession,
  logClaimEvent,
  adoptWorkspaceFromSibling,
} from "./resolvers";
import { listCurrentConnections, setCurrentConnection } from "../../lib/current-connection";
import { verifyClaimToken } from "../../lib/claim-token";
import { checkItemCreateAllowed } from "../../lib/usage-service";
import { checkBurstLimit, BURST } from "../../lib/free-plan-throttle";
import { listLanguages, getLanguageInfo } from "./languages";
import { client } from "../../lib/auth";
import { findAccounts, isSystemAccount, profileName, shortAccountId } from "../../lib/account-lookup";
import { getCredentialsForApiKey } from "../../lib/api-credentials";
import {
  listConnections,
  createConnection,
  rotateConnection,
  disableConnection,
  deleteConnection,
  shareConnection,
  updateConnectionGrant,
  listShareableFunctions,
  listConnectionFunctions,
  setOwnerPermissions,
  listConnectionGrants,
  revokeConnectionGrant,
  listSharedConnections,
  leaveSharedConnection,
  claimConnectionGrants,
  PolicyError,
} from "../../lib/policy-client";
import {
  accountExists,
  accountForEmail,
  accountLabel,
  emailHash,
  isAccountId,
  isEmail,
  normalizeAccountId,
  normalizeEmail,
  verifiedEmailHashes,
} from "../../lib/connection-sharing";
import { enqueueGenerationJob } from "../../lib/generation-queue";
import {
  FreePlanError,
  getFreePlanCredentials,
  isFreePlanRequest,
} from "../../lib/free-plan-context";
import { hashUid, langKey } from "../../lib/funnel-events";
import { isInternalRequest } from "../../lib/funnel-exclusions";
import {
  registerFirstCreateAttempt,
  resolveFirstOutcome,
} from "../../lib/workspace-registry";

// Normalizes any inbound credential into { uid, idToken }, where idToken is
// always a Firebase ID token (or signed JWT) suitable for forwarding to
// api.graffiticode.org. Inbound can be either a Firebase ID token or a raw
// Graffiticode api key — the api-key path exchanges via the auth service.
async function authenticate(token: string): Promise<{ uid: string; idToken: string }> {
  try {
    const { uid } = await client.verifyToken(token);
    return { uid, idToken: token };
  } catch {
    const { uid, idToken } = await getCredentialsForApiKey(token);
    return { uid, idToken };
  }
}

type AuthContext = {
  uid: string;
  token: string;
  freePlan?: boolean;
  sessionNamespace?: string;
  sessionUuid?: string;
};

async function resolveAuth(ctx): Promise<AuthContext> {
  if (ctx.freePlan) {
    const { uid, idToken } = await getFreePlanCredentials();
    // A fresh object per request — resolvers may rebind sessionNamespace onto it
    // (adoptWorkspace) and that must not leak across requests.
    return {
      uid,
      token: idToken,
      freePlan: true,
      sessionNamespace: ctx.sessionNamespace,
      sessionUuid: ctx.sessionUuid,
    };
  }
  const { uid, idToken } = await authenticate(ctx.token);
  return { uid, token: idToken };
}

// Policy errors surface as their reason only ("not-owner", "unavailable", …).
async function viaPolicy<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PolicyError) {
      throw new Error(`Connection request refused: ${err.reason ?? err.status}`);
    }
    throw err;
  }
}

// A grant's access from shareConnection/updateConnectionGrant args. Policy
// checks the permissions against the connection's shareable functions.
function grantAccess(args: any) {
  if (!args.permissions?.length) throw new Error("Choose at least one function.");
  return {
    permissions: args.permissions.map(({ lang, fn }) => ({ lang, fn })),
    expiresAt: args.expiresAt ?? null,
  };
}

const typeDefs = `
  type Compile {
    id: String!
    timestamp: String!
    status: String!
    lang: String
  }

  # One recorded content state of an item. Pointer-only: taskId addresses the
  # immutable, content-addressed task on api.graffiticode.org.
  type TaskVersion {
    id: String!
    itemId: String!
    taskId: String!
    lang: String!
    langs: [String!]!
    name: String
    mark: Int
    client: String
    source: String
    label: String
    createdAt: String!
  }

  type Task {
    id: String!
    lang: String!
    langs: [String!]
    code: String!
    src: String!
    help: String!
    taskId: String!
    isPublic: Boolean
    created: String
    mark: Int
    name: String
  }

  type Item {
    id: String!
    name: String!
    taskId: String
    lang: String!
    mark: Int
    help: String
    isPublic: Boolean
    created: String!
    updated: String
    sharedWith: [String]
    client: String
    upstreamLangs: [String!]
    task: Task
    generationStatus: String
    generationError: String
    generationStartedAt: String
    # Characters written so far by a RUNNING generation; null once terminal.
    generationChars: Int
    # Free-plan only. workspace is a signed handle the client sends back as
    # X-Free-Plan-Session so its next call lands in the same workspace even
    # though its transport session is gone; claimToken addresses that
    # workspace's items for /claim. Both are null for authenticated callers.
    workspace: String
    claimToken: String
    # The current connection for the item's language (delegated API
    # permissions): what its saves write through and what previews show. Not
    # stored on the item. Null when none.
    connectionId: String
    # Its publication while it is public, and the connection that publication
    # was made through (kept when the current connection changes).
    publicationId: String
    publicationConnectionId: String
    # The version the publication shows; older than taskId after an edit,
    # until the item is republished.
    publishedTaskId: String
    # The outcome of the latest write through a connection. For the current
    # version only when lastWrite.taskId equals taskId.
    lastWrite: ItemWrite
  }

  type ItemCount {
    lang: String!
    count: Int!
  }

  type ItemWrite {
    taskId: String!
    connectionId: String
    # "ok", "failed" or "skipped". failed: message says why. skipped: the
    # program saves to the item bank but there was no connection to write
    # through (message "no-connection"). A later write replaces either.
    status: String!
    message: String
    at: String!
  }

  # The connection a language's saves write through, system-wide per user.
  # connectionId is the explicit choice while it is still a candidate, else the
  # sole candidate, else null. explicit: it is the stored choice.
  type CurrentConnection {
    lang: String!
    backend: String!
    connectionId: String
    explicit: Boolean!
    candidates: [Connection!]!
  }

  type GenerationJob {
    itemId: String!
    status: String!
    # The workspace the item actually landed in, as the same sha256 namespace the
    # funnel already logs. NOT a credential — the console only ever accepts a
    # *signed* session token — so it is safe to return and to log. Lets a caller
    # see whether a siblingOf hint was honoured. Null for authenticated callers.
    workspaceNamespace: String
  }

  type GeneratedCode {
    src: String
    taskId: String
    description: String
    changeSummary: String
    language: String
    model: String
    provider: String
    tier: String
    usage: UsageInfo
    errors: [CodeError]
    upstreamLangs: [String!]
  }

  type CodeError {
    message: String!
    from: Int
    to: Int
  }

  type ParseResult {
    code: String
    errors: [CodeError]
  }

  type UsageInfo {
    input_tokens: Int
    output_tokens: Int
  }

  type Language {
    id: String!
    name: String!
    description: String!
    routingHint: String
    domains: [String!]!
  }

  type ReactComponent {
    package: String!
    component: String!
    styleImport: String
  }

  type ExamplePrompt {
    prompt: String!
    produces: String
    notes: String
  }

  type LanguageScope {
    summary: String!
    inScope: [String!]!
    outOfScope: [String!]!
  }

  type LanguageInfo {
    id: String!
    name: String!
    description: String!
    routingHint: String
    domains: [String!]!
    examples: [String!]
    reactComponent: ReactComponent
    specUrl: String!
    authoringGuide: String
    supportedItemTypes: [String!]
    examplePrompts: [ExamplePrompt!]
    usageGuide: String
    scope: LanguageScope
  }

  type CompileAllowedResponse {
    allowed: Boolean!
    reason: String
    currentUsage: Int
    totalAvailable: Int
  }

  # An external-API connection the user owns. Its credential lives only in the
  # credential broker; it is never returned here.
  type Connection {
    connectionId: String!
    backend: String!
    status: String!
    label: String
    # A Graffiticode system connection: it signs previews only and is never
    # used for saves, so it is never a current-connection candidate.
    system: Boolean!
    # True for a connection another account owns and shared with this user;
    # permissions says which (language, function) pairs it allows.
    shared: Boolean!
    permissions: [Permission!]
    expiresAt: String
    # For a shared connection: the account that shared it (profile name, or
    # its short ID when it has none). Null for the caller's own connections.
    sharedBy: SharedBy
    # For the caller's own connections: what they allow themselves through it.
    # Null is everything (and always null for a shared connection).
    ownerPermissions: [Permission!]
  }

  type SharedBy {
    name: String!
    shortId: String!
  }

  # One function in one language, e.g. { lang: "0176", fn: "save-to-itembank" }.
  type Permission {
    lang: String!
    fn: String!
  }

  input PermissionInput {
    lang: String!
    fn: String!
  }

  # A function a grant on a connection can include; kind is sign, read or write.
  type ShareableFunction {
    lang: String!
    fn: String!
    kind: String!
  }

  # A protected function on a connection's backend. The owner's own access may
  # include any of them; a share only the delegable ones. An implicit function
  # (rendering) also comes with any other function in its language.
  type ConnectionFunction {
    lang: String!
    fn: String!
    kind: String!
    implicit: Boolean!
    delegable: Boolean!
  }

  # One person a connection is shared with, as its owner sees it. pending: shared
  # to an email that has not signed in yet.
  type ConnectionGrant {
    grantId: String!
    recipient: String
    pending: Boolean!
    permissions: [Permission!]!
    expiresAt: String
    createdAt: String!
  }

  type Query {
    checkItemCreateAllowed: CompileAllowedResponse!
    connections: [Connection!]!
    currentConnections: [CurrentConnection!]!
    connectionGrants(connectionId: String!): [ConnectionGrant!]!
    shareableFunctions(connectionId: String!): [ShareableFunction!]!
    connectionFunctions(connectionId: String!): [ConnectionFunction!]!
    parse(lang: String!, src: String!, itemId: String): ParseResult!
    # connectionId: view the caller's stored result through that connection.
    data(id: String!, connectionId: String): String!
    compiles(lang: String!, type: String!): [Compile!]
    taskVersions(lang: String!, client: String, itemId: String, limit: Int, startAfter: String): [TaskVersion!]!
    tasks(lang: String!, mark: Int!): [Task!]
    task(id: String!): Task
    items(lang: String!, mark: Int, client: String): [Item!]
    # How many items the caller has in each language (all clients, mark 5
    # excluded), counted without reading the items.
    itemCounts(langs: [String!]!): [ItemCount!]!
    # The names of the caller's items in a language (optionally one mark),
    # read without loading the items.
    itemNames(lang: String!, mark: Int): [String!]!
    item(id: String!): Item
    spec(id: String!): ItemSpec!
    itemClientTags(lang: String!): [String!]!
    languages(search: String, domain: String): [Language!]!
    language(id: String!): LanguageInfo
    itemData(id: String!): String!
    # Accounts to share with, for a typeahead: any account whose profile name,
    # linked email or account ID contains the query (any case). At least 2
    # characters; at most 10 matches, exact then prefix then substring; never
    # the caller or the shared trial account; never returns an email.
    findAccounts(query: String!): [AccountMatch!]!
  }

  type AccountMatch {
    accountId: String!
    # Profile name, or the short ID when the account has none.
    name: String!
    shortId: String!
    # "email", "name" or "id".
    matchedBy: String!
  }

  type ShareItemResult {
    success: Boolean!
    message: String
    newItemId: String
  }

  type SpecCoverage {
    checked: Int!
    missing: [String!]!
  }

  type ItemSpec {
    spec: String!
    lang: String!
    itemId: String!
    coverage: SpecCoverage!
  }

  type ClaimedItem {
    id: String!
    lang: String!
  }

  type ClaimResult {
    transferred: Int!
    sessionNamespace: String!
    items: [ClaimedItem!]!
  }

  type Mutation {
    logCompile(units: Int, id: String!, status: String!, timestamp: String!, data: String!): String!
    postTask(lang: String!, code: String!, ephemeral: Boolean, item: String): String!
    generateCode(prompt: String!, language: String!, options: CodeGenerationOptions, currentSrc: String, currentData: String, conversationSummary: ConversationSummaryInput, itemId: String): GeneratedCode!
    startCodeGeneration(itemId: String, siblingOf: String, lang: String!, name: String, client: String, clientKind: String, geoCountry: String, prompt: String!, modification: String!, currentSrc: String, currentData: String): GenerationJob!
    createItem(lang: String!, name: String, taskId: String, mark: Int, help: String, isPublic: Boolean, client: String, upstreamLangs: [String!], source: String, label: String): Item!
    updateItem(id: String!, name: String, taskId: String, mark: Int, help: String, isPublic: Boolean, client: String, upstreamLangs: [String!], source: String, label: String): Item!
    # Choose the connection a language's saves write through; null clears the
    # choice (a sole candidate is then used automatically).
    setCurrentConnection(lang: String!, connectionId: String): [CurrentConnection!]!
    # Write the item's current version through the current connection again.
    retryItemWrite(id: String!): Item!
    # Compile the item's current version again instead of using the cached
    # result. Through a connection it writes again (a fresh idempotency key).
    recompileItem(id: String!): Item!
    # Move a published item's publication to its current version, through the
    # current connection.
    republishItem(id: String!): Item!
    shareItem(itemId: String!, targetUserId: String!): ShareItemResult!
    claimFreePlanSession(token: String!): ClaimResult!
    createConnection(backend: String!, label: String, key: String!, secret: String!): Connection!
    rotateConnection(connectionId: String!, key: String!, secret: String!): Boolean!
    disableConnection(connectionId: String!): Boolean!
    deleteConnection(connectionId: String!): Boolean!
    # Share a connection with a person, named by email or by account ID (exactly
    # one), allowing exactly the functions named. By email it succeeds the same
    # way whether or not the email has an account yet; by account ID the account
    # must exist.
    shareConnection(connectionId: String!, email: String, accountId: String, permissions: [PermissionInput!]!, expiresAt: String): Boolean!
    # Change a grant's functions or end date; the recipient stays.
    updateConnectionGrant(connectionId: String!, grantId: String!, permissions: [PermissionInput!]!, expiresAt: String): Boolean!
    revokeConnectionGrant(connectionId: String!, grantId: String!): Boolean!
    # What the owner allows themselves through their connection; null restores
    # everything. Independent of what they share.
    setOwnerPermissions(connectionId: String!, permissions: [PermissionInput!]): Boolean!
    leaveSharedConnection(connectionId: String!): Boolean!
  }

  # Model selection is deliberately absent. Which model family and tier serve a
  # request is a server decision driven by the language's static priority list
  # (src/lib/model-priority.ts) — see docs/language-routing-and-composition.md.
  # Neither an end user nor a client agent (including MCP) may influence it, so
  # there is no provider/tier/model field here to influence it with.
  input CodeGenerationOptions {
    temperature: Float
    maxTokens: Int
  }

  input ConversationSummaryInput {
    turnCount: Int!
    previousRequests: [String!]!
    previousOutputs: [String]
  }
`;

const resolvers = {
  Query: {
    checkItemCreateAllowed: async (_, __, ctx) => {
      // Free-plan callers get a real answer now that the trial is metered in
      // items against the trial account's own plan allowance — it used to
      // return an unconditional `allowed: true` because the trial was capped in
      // dollars, in a unit this query couldn't express.
      if (ctx.freePlan) {
        try {
          const { uid } = await resolveAuth(ctx);
          return await checkItemCreateAllowed(uid, { failClosed: true, skipSelfHeal: true, skipSubscriptionRepair: true });
        } catch (error) {
          return { allowed: false, reason: 'Unable to verify item limit' };
        }
      }
      const { token } = ctx;
      if (!token) {
        return { allowed: false, reason: 'Not authenticated' };
      }
      try {
        const { uid } = await authenticate(token);
        return await checkItemCreateAllowed(uid);
      } catch (error) {
        return { allowed: false, reason: 'Authentication failed' };
      }
    },
    parse: async (_, args, ctx) => {
      const { lang, src, itemId } = args;
      // itemId is the one parse-time value. Stored user credentials are retired:
      // external APIs are reached only through a connection.
      const publicValues: Record<string, string> = itemId ? { itemId } : {};
      return await parseCode({ lang, src, publicValues });
    },
    connections: async (_, __, ctx) => {
      if (ctx.freePlan) return [];
      const auth = await resolveAuth(ctx);
      // Shares made to this user's emails before they had an account become
      // theirs now. Best effort: a failure here only delays them.
      const hashes = await verifiedEmailHashes(auth.token);
      if (hashes.length) {
        await claimConnectionGrants(auth.token, hashes).catch(() => null);
      }
      const [owned, shared] = await viaPolicy(() => Promise.all([
        listConnections(auth.token),
        listSharedConnections(auth.token),
      ]));
      // Who shared each one: their profile name (or short ID) — never more.
      const owners = new Map<string, { name: string; shortId: string } | null>();
      await Promise.all([...new Set(shared.map(c => c.ownerUid).filter(Boolean) as string[])].map(async uid => {
        const shortId = shortAccountId(uid);
        const name = await profileName(uid).catch(() => null);
        owners.set(uid, { name: name || shortId, shortId });
      }));
      return [
        ...owned.map(c => ({ ...c, ownerPermissions: c.ownerPermissions ?? null, shared: false, permissions: null, expiresAt: null, sharedBy: null })),
        ...shared.map(c => ({ ...c, ownerPermissions: null, shared: true, sharedBy: (c.ownerUid && owners.get(c.ownerUid)) || null })),
      ];
    },
    currentConnections: async (_, __, ctx) => {
      if (ctx.freePlan) return [];
      const auth = await resolveAuth(ctx);
      return await viaPolicy(() => listCurrentConnections({ auth }));
    },
    connectionGrants: async (_, args, ctx) => {
      if (ctx.freePlan) return [];
      const auth = await resolveAuth(ctx);
      const grants = await viaPolicy(() => listConnectionGrants(auth.token, args.connectionId));
      return grants.map(g => ({ ...g, permissions: g.permissions ?? [], recipient: g.recipientLabel }));
    },
    shareableFunctions: async (_, args, ctx) => {
      if (ctx.freePlan) return [];
      const auth = await resolveAuth(ctx);
      return await viaPolicy(() => listShareableFunctions(auth.token, args.connectionId));
    },
    connectionFunctions: async (_, args, ctx) => {
      if (ctx.freePlan) return [];
      const auth = await resolveAuth(ctx);
      return await viaPolicy(() => listConnectionFunctions(auth.token, args.connectionId));
    },
    data: async (_, args, ctx) => {
      const { id } = args;
      const connectionId = ctx.freePlan ? null : (args.connectionId ?? null);
      const auth = await resolveAuth(ctx);
      const data = await getData({ authToken: auth.token, id, connectionId });
      return JSON.stringify(data);
    },
    compiles: async (_, args, ctx) => {
      if (ctx.freePlan) return [];
      const { token } = ctx;
      const { lang, type } = args;
      const { uid, idToken } = await authenticate(token);
      return await compiles({ auth: { uid, token: idToken }, lang, type });
    },
    taskVersions: async (_, args, ctx) => {
      // Browser-only surface (the console requires real sign-in), same as compiles.
      if (ctx.freePlan) return [];
      const { token } = ctx;
      const { lang, client, itemId, limit, startAfter } = args;
      const { uid, idToken } = await authenticate(token);
      return await getTaskVersions({
        auth: { uid, token: idToken },
        lang,
        client,
        itemId,
        limit,
        startAfter,
      });
    },
    tasks: async (_, args, ctx) => {
      if (ctx.freePlan) return [];
      const { token } = ctx;
      const { lang, mark } = args;
      const { uid, idToken } = await authenticate(token);
      return await getTasks({ auth: { uid, token: idToken }, lang, mark });
    },
    task: async (_, args, ctx) => {
      const { id } = args;
      const auth = await resolveAuth(ctx);
      return await getTask({ auth, id });
    },
    items: async (_, args, ctx) => {
      const { lang, mark, client } = args;
      const auth = await resolveAuth(ctx);
      return await getItems({ auth, lang, mark, client });
    },
    itemCounts: async (_, args, ctx) => {
      const auth = await resolveAuth(ctx);
      return await countItems({ auth, langs: args.langs });
    },
    itemNames: async (_, args, ctx) => {
      const auth = await resolveAuth(ctx);
      return await getItemNames({ auth, lang: args.lang, mark: args.mark ?? null });
    },
    item: async (_, args, ctx) => {
      const { id } = args;
      const auth = await resolveAuth(ctx);
      return await getItem({ auth, id });
    },
    spec: async (_, args, ctx) => {
      const { id } = args;
      const auth = await resolveAuth(ctx);
      return await getSpec({ auth, id });
    },
    itemClientTags: async (_, args, ctx) => {
      const { lang } = args;
      const auth = await resolveAuth(ctx);
      return await getItemClientTags({ auth, lang });
    },
    languages: async (_, args) => {
      const { search, domain } = args;
      // Internal dialects never belong in the CATALOG, which is what an agent routes
      // against: L0010 plans compositions and L0013 makes thumbnails, and neither is
      // a content-authoring target. They were reachable here because listLanguages()
      // filters `hidden` and `Deprecated` but not `internal` — invisible while no
      // search matched their text, and `keywords` made matches more likely ("mind map"
      // reached L0010, whose hint says it "maps a request to a language sequence").
      //
      // Filtered at this boundary rather than inside listLanguages() because the
      // router also uses that function to LOOK UP a language by id, internal ones
      // included; removing them there would quietly degrade those lookups. The
      // router already excludes internal from its own candidate list.
      const languages = await listLanguages({ search, domain });
      return languages.filter((l) => !l.internal);
    },
    language: async (_, args) => {
      const { id } = args;
      return await getLanguageInfo(id);
    },
    findAccounts: async (_, args, ctx) => {
      if (ctx.freePlan) throw new Error("Sharing requires a full account.");
      const { uid } = await authenticate(ctx.token);
      return await findAccounts(uid, args.query);
    },
    itemData: async (_, args, ctx) => {
      const { id } = args;
      const auth = await resolveAuth(ctx);
      const item = await getItem({ auth, id });
      if (!item || !item.taskId) {
        throw new Error("Item not found or has no associated task");
      }
      const data = await getData({ authToken: auth.token, id: item.taskId });
      return JSON.stringify(data);
    },
  },
  Mutation: {
    generateCode: async (_, args, ctx) => {
      const auth = await resolveAuth(ctx);
      const { prompt, language, options, currentSrc, currentData, conversationSummary, itemId } = args;
      // What `currentSrc` compiled to, as the client already had it (a JSON
      // string — the schema has no JSON scalar, and every other data-shaped
      // field here travels the same way). CONTEXT ONLY: some dialects keep
      // values outside the program, so the source alone cannot answer an edit
      // about them. Unparseable means no context, never a failed generation —
      // it decorates the prompt, so it must not be able to break it.
      let parsedCurrentData: unknown = null;
      if (typeof currentData === "string" && currentData.length > 0) {
        try {
          parsedCurrentData = JSON.parse(currentData);
        } catch {
          parsedCurrentData = null;
        }
      }
      try {
        return await generateCodeForRequest({ auth, prompt, language, options, currentSrc, currentData: parsedCurrentData, conversationSummary, itemId });
      } catch (error) {
        if (error instanceof FreePlanError) throw error;
        console.error("Error in generateCode mutation:", error);
        throw error;
      }
    },

    // Async generation: mark the item "generating" and enqueue a Cloud Task that
    // runs the (60-110s) generation in /api/generate-job, then return immediately.
    // Lets MCP clients with short tool-call timeouts poll get_item for completion
    // instead of holding one long call. See src/lib/generation-queue.ts.
    startCodeGeneration: async (_, args, ctx) => {
      const {
        itemId,
        siblingOf,
        lang,
        name,
        client,
        clientKind,
        geoCountry,
        prompt,
        modification,
        currentSrc,
        currentData,
      } = args;

      // The agent OMTM counts a workspace's FIRST create attempt, any outcome.
      // Gated on `!itemId` because this resolver serves update_item too, and a
      // revision is not a new workspace.
      //
      // Free-plan registers BEFORE resolveAuth: the namespace is already on ctx,
      // so an attempt whose credential exchange fails still lands a row.
      //
      // The hints arrive either way — a GraphQL arg (explicit, per call) or a
      // header (per connection). Whichever the caller sends.
      //
      // geoCountry MUST be forwarded: MCP→console is a server-to-server fetch
      // from Cloud Run, so there is no edge in front of this request to read it
      // from. Reading our own headers here would record our egress region.
      const hints = {
        lang: langKey(lang),
        clientKind: clientKind ?? ctx.clientKind,
        geoCountry: geoCountry ?? ctx.geoCountry,
      };
      //
      // Also gated on `!siblingOf`: a sibling create JOINS an existing workspace,
      // so it is by definition not a new one. Without this, a transport-per-call
      // client registers one "new creating workspace" per ITEM and the agent OMTM
      // reports create volume as user growth.
      if (!itemId && !siblingOf && ctx.freePlan && ctx.sessionNamespace) {
        await registerFirstCreateAttempt({
          key: ctx.sessionNamespace,
          auth: "free",
          ...hints,
          internal: isInternalRequest({
            internalHeader: ctx.internalHeader,
            sessionNamespace: ctx.sessionNamespace,
          }),
        });
      }

      const auth = await resolveAuth(ctx);

      // Adopt BEFORE createItem: freePlanItemFields(auth) stamps the new item with
      // auth.sessionNamespace, so the rebind has to land first or the item is
      // written into the very workspace we are trying to escape.
      if (!itemId) {
        await adoptWorkspaceFromSibling(auth, siblingOf);
      }

      // Authenticated has to wait for the uid. Keyed on sha256(uid) so a token
      // rotation doesn't invent a second workspace.
      //
      // Free-plan reads the ADOPTED namespace, not the header's: resolveFirstOutcome
      // has to land on the row this create actually belongs to.
      let workspaceKey = ctx.freePlan
        ? (auth.sessionNamespace ?? ctx.sessionNamespace)
        : undefined;
      if (!ctx.freePlan && auth.uid) {
        workspaceKey = hashUid(auth.uid);
        if (!itemId) {
          await registerFirstCreateAttempt({
            key: workspaceKey,
            auth: "firebase",
            ...hints,
            internal: isInternalRequest({
              internalHeader: ctx.internalHeader,
              uidHash: workspaceKey,
            }),
          });
        }
      }
      // Credential the worker replays to act as this caller. For free-plan we
      // re-derive fresh credentials in the worker (idTokens are short-lived and
      // dispatch can lag), so carry the session, not a baked idToken.
      //
      // Carries the ADOPTED namespace: the item has just been written into the
      // sibling's workspace, so a worker replaying the pre-adoption one would act
      // as a different workspace than the item it is generating for.
      const authReplay = ctx.freePlan
        ? {
            kind: "freePlan" as const,
            sessionNamespace: auth.sessionNamespace ?? ctx.sessionNamespace,
            sessionUuid: ctx.sessionUuid,
          }
        : { kind: "bearer" as const, token: ctx.token };

      let id = itemId;
      if (!id) {
        try {
          const shell = await createItem({ auth, lang, name, client, deferGeneration: true }) as unknown as { id: string };
          id = shell.id;
        } catch (err) {
          // The synchronous half of firstOutcome. A refusal at the quota gate is
          // still an attempt the OMTM counts, and it is the case that otherwise
          // leaves no Firestore row at all — assertItemCreateAllowed throws
          // before the item shell is written.
          const cause = (err as { cause?: unknown })?.cause;
          await resolveFirstOutcome(
            workspaceKey,
            cause instanceof FreePlanError ? "wall" : "error",
          );
          throw err;
        }
      } else {
        await setItemGenerationStatus({ auth, id, status: "generating" });
      }

      await enqueueGenerationJob({
        itemId: id,
        lang,
        prompt,
        modification,
        currentSrc,
        // Serialized JSON, passed through untouched: the worker hands it to
        // generateCodeForRequest, which parses and renders it as <CURRENT_DATA>.
        // Kept as a string end to end so the queue payload stays one flat shape.
        currentData,
        authReplay,
        client,
      });

      return {
        itemId: id,
        status: "generating",
        workspaceNamespace: auth.freePlan ? (auth.sessionNamespace ?? null) : null,
      };
    },

    postTask: async (_, args, ctx) => {
      const { lang, code: codeStr, ephemeral, item } = args;
      const auth = await resolveAuth(ctx);
      const code = JSON.parse(codeStr);
      const task: Record<string, unknown> = { lang, code };
      if (item) {
        task.item = item;
      }
      // A task backing a public item must itself be public, else anonymous
      // viewers can't load edits. Visibility follows the item; free-plan items
      // are never public. (isPublic posts anonymously, so the task is created
      // public — no owner uid needed: public reads bypass the acl uid check.)
      let isPublic = false;
      if (item && !auth.freePlan) {
        const existing = await getItem({ auth, id: item });
        isPublic = !!existing?.isPublic;
      }
      const { id } = await postTask({ auth, task, ephemeral: ephemeral || auth.freePlan, isPublic });
      return id;
    },
    logCompile: async (_, args, ctx) => {
      const { units, id, timestamp, status, data } = args;
      console.log(
        "logCompile()",
        "units=" + units,
      );
      if (ctx.freePlan) {
        return JSON.stringify({ success: true });
      }
      const { token } = ctx;
      const { uid, idToken } = await authenticate(token);
      const resp = await logCompile({ auth: { uid, token: idToken }, units, id, timestamp, status, data });
      return resp;
    },
    createItem: async (_, args, ctx) => {
      const { lang, name, taskId, mark, help, isPublic, client, upstreamLangs, source, label } = args;
      const auth = await resolveAuth(ctx);
      return await createItem({ auth, lang, name, taskId, mark, help, isPublic, client, upstreamLangs, source, label });
    },
    updateItem: async (_, args, ctx) => {
      const { id, name, taskId, mark, help, isPublic, client, upstreamLangs, source, label } = args;
      const auth = await resolveAuth(ctx);
      return await updateItem({ auth, id, name, taskId, mark, help, isPublic, client, upstreamLangs, source, label });
    },
    setCurrentConnection: async (_, args, ctx) => {
      if (ctx.freePlan) throw new Error("Connections require a full account.");
      const auth = await resolveAuth(ctx);
      return await viaPolicy(() => setCurrentConnection({ auth, lang: args.lang, connectionId: args.connectionId ?? null }));
    },
    retryItemWrite: async (_, args, ctx) => {
      if (ctx.freePlan) throw new Error("Connections require a full account.");
      const auth = await resolveAuth(ctx);
      return await viaPolicy(() => retryItemWrite({ auth, id: args.id }));
    },
    recompileItem: async (_, args, ctx) => {
      const auth = await resolveAuth(ctx);
      return await viaPolicy(() => recompileItem({ auth, id: args.id }));
    },
    republishItem: async (_, args, ctx) => {
      if (ctx.freePlan) throw new Error("Connections require a full account.");
      const auth = await resolveAuth(ctx);
      return await viaPolicy(() => republishItem({ auth, id: args.id }));
    },
    shareItem: async (_, args, ctx) => {
      if (ctx.freePlan) {
        throw new Error("Sharing requires a full account.");
      }
      const { token } = ctx;
      const { itemId, targetUserId } = args;
      const { uid, idToken } = await authenticate(token);
      return await shareItem({ auth: { uid, token: idToken }, itemId, targetUserId });
    },
    claimFreePlanSession: async (_, args, ctx) => {
      // Instrument failures that happen BEFORE the transfer runs (auth, token
      // verification, credentials) — claimFreePlanSession logs its own ok/error,
      // so `enteredInner` prevents double-logging transfer-phase failures.
      let sessionNamespace: string | undefined;
      let enteredInner = false;
      try {
        if (ctx.freePlan) {
          throw new Error("Claim requires a real account, not a free-plan session.");
        }
        const { token } = ctx;
        if (!token) {
          throw new Error("Authentication required.");
        }
        const { uid, idToken } = await authenticate(token);

        let payload;
        try {
          payload = await verifyClaimToken(args.token);
        } catch (err: any) {
          throw new Error(`Invalid or expired claim link: ${err?.message || "verification failed"}`);
        }
        sessionNamespace = payload.sessionNamespace;

        const { uid: trialUid, idToken: trialIdToken } = await getFreePlanCredentials();
        enteredInner = true;
        return await claimFreePlanSession({
          auth: { uid, token: idToken },
          trialAuth: { uid: trialUid, token: trialIdToken },
          sessionNamespace: payload.sessionNamespace,
          sessionUuid: payload.sessionUuid,
        });
      } catch (err: any) {
        if (!enteredInner) {
          logClaimEvent({
            outcome: "error",
            session: sessionNamespace ?? "unverified",
            err: String(err?.message ?? err),
          });
        }
        throw err;
      }
    },
    createConnection: async (_, args, ctx) => {
      if (ctx.freePlan) throw new Error("Connections require a full account.");
      const auth = await resolveAuth(ctx);
      return await viaPolicy(() => createConnection(auth.token, {
        backend: args.backend, label: args.label, key: args.key, secret: args.secret,
      }));
    },
    rotateConnection: async (_, args, ctx) => {
      if (ctx.freePlan) throw new Error("Connections require a full account.");
      const auth = await resolveAuth(ctx);
      await viaPolicy(() => rotateConnection(auth.token, args.connectionId, { key: args.key, secret: args.secret }));
      return true;
    },
    disableConnection: async (_, args, ctx) => {
      if (ctx.freePlan) throw new Error("Connections require a full account.");
      const auth = await resolveAuth(ctx);
      await viaPolicy(() => disableConnection(auth.token, args.connectionId));
      return true;
    },
    shareConnection: async (_, args, ctx) => {
      if (ctx.freePlan) throw new Error("Connections require a full account.");
      const byEmail = typeof args.email === "string" && args.email.trim() !== "";
      const byAccount = typeof args.accountId === "string" && args.accountId.trim() !== "";
      if (byEmail === byAccount) throw new Error("Enter an email address or an account ID.");
      if (byEmail && !isEmail(args.email)) throw new Error("Enter a valid email address.");
      if (byAccount && !isAccountId(args.accountId)) throw new Error("An account ID is 40 hexadecimal characters, with or without 0x.");
      const access = grantAccess(args);
      const auth = await resolveAuth(ctx);
      if (byAccount) {
        const recipientUid = normalizeAccountId(args.accountId);
        if (recipientUid === auth.uid) throw new Error("You already own this connection.");
        if (isSystemAccount(recipientUid) || !(await accountExists(recipientUid))) throw new Error("No account has that ID.");
        const recipientLabel = (await profileName(recipientUid)) || accountLabel(recipientUid);
        await viaPolicy(() => shareConnection(auth.token, args.connectionId, {
          recipientUid,
          recipientLabel,
          ...access,
        }));
        return true;
      }
      const email = normalizeEmail(args.email);
      const recipientUid = await accountForEmail(email);
      if (recipientUid === auth.uid) throw new Error("You already own this connection.");
      await viaPolicy(() => shareConnection(auth.token, args.connectionId, {
        ...(recipientUid ? { recipientUid } : { recipientEmailHash: emailHash(email) }),
        recipientLabel: email,
        ...access,
      }));
      return true;
    },
    updateConnectionGrant: async (_, args, ctx) => {
      if (ctx.freePlan) throw new Error("Connections require a full account.");
      const access = grantAccess(args);
      const auth = await resolveAuth(ctx);
      await viaPolicy(() => updateConnectionGrant(auth.token, args.connectionId, args.grantId, access));
      return true;
    },
    revokeConnectionGrant: async (_, args, ctx) => {
      if (ctx.freePlan) throw new Error("Connections require a full account.");
      const auth = await resolveAuth(ctx);
      await viaPolicy(() => revokeConnectionGrant(auth.token, args.connectionId, args.grantId));
      return true;
    },
    setOwnerPermissions: async (_, args, ctx) => {
      if (ctx.freePlan) throw new Error("Connections require a full account.");
      const auth = await resolveAuth(ctx);
      const permissions = Array.isArray(args.permissions) ? args.permissions.map(({ lang, fn }) => ({ lang, fn })) : null;
      await viaPolicy(() => setOwnerPermissions(auth.token, args.connectionId, permissions));
      return true;
    },
    leaveSharedConnection: async (_, args, ctx) => {
      if (ctx.freePlan) throw new Error("Connections require a full account.");
      const auth = await resolveAuth(ctx);
      await viaPolicy(() => leaveSharedConnection(auth.token, args.connectionId));
      return true;
    },
    deleteConnection: async (_, args, ctx) => {
      if (ctx.freePlan) throw new Error("Connections require a full account.");
      const auth = await resolveAuth(ctx);
      await viaPolicy(() => deleteConnection(auth.token, args.connectionId));
      return true;
    },
  },
  Item: {
    task: async (parent, _, ctx) => {
      if (!parent?.taskId) return null;
      const auth = await resolveAuth(ctx);
      return await getTask({ auth, id: parent.taskId });
    },
  },
};

const schema = makeExecutableSchema({ typeDefs, resolvers });

/** Telemetry-only connection hints. Absent is always fine — see contextFactory. */
function readClientHints(req): {
  clientKind?: string;
  geoCountry?: string;
  internalHeader?: string;
} {
  const one = (v: unknown) => (Array.isArray(v) ? v[0] : v);
  return {
    clientKind: one(req.headers["x-client-kind"]),
    geoCountry: one(req.headers["x-client-geo"]),
    internalHeader: one(req.headers["x-gc-internal"]),
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Free-Plan-Session, X-Client-Kind, X-Client-Geo, X-GC-Internal",
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const request = {
    method: req.method,
    headers: req.headers,
    query: req.query,
    body: req.body,
  };
  if (shouldRenderGraphiQL(request)) {
    const { auth_token } = req.query;
    const html = renderGraphiQL({
      endpoint: "/api",
      headers: `{ "authorization": "${auth_token}" }`,
    });
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } else {
    let freePlan: Awaited<ReturnType<typeof isFreePlanRequest>>;
    try {
      freePlan = await isFreePlanRequest(req);
      // Hammering guard for every free-plan surface, applied once here rather
      // than resolver by resolver — reads, writes and anything added later are
      // covered without having to remember to. Generously sized (see BURST.API);
      // the actual budget is items, enforced at creation.
      if (freePlan.freePlan) {
        await checkBurstLimit(freePlan.sessionNamespace, BURST.API);
      }
    } catch (err) {
      // A rejected free-plan session (bad signature, expired, or raw uuid once
      // signed sessions are required) is an auth failure, not a GraphQL error.
      // Rate-limit rejections land here too and carry their own 429 + payload.
      const status = (err as any)?.status || 401;
      const payload = (err as any)?.payload || { error: "free_plan_session_invalid" };
      res.status(status).json(payload);
      return;
    }
    const { operationName, query, variables } = getGraphQLParameters(request);
    const result = await processRequest({
      operationName,
      query,
      variables,
      request,
      schema,
      contextFactory: () => ({
        token: req.headers.authorization,
        freePlan: freePlan.freePlan,
        sessionUuid: freePlan.freePlan ? freePlan.sessionUuid : undefined,
        sessionNamespace: freePlan.freePlan ? freePlan.sessionNamespace : undefined,
        // Caller-asserted telemetry hints, headers rather than GraphQL args
        // because they describe the connection, not the mutation — same
        // convention as X-Free-Plan-Session. Sanitized where they are stored
        // (workspace-registry). NEVER used for authorization or quota.
        ...readClientHints(req),
      }),
    });
    sendResult(result, res);
  }
}
