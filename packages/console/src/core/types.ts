// Moved from pages/api/resolvers.ts (Phase 1: untangle inside the console).


export type AuthArg = {
  uid: string;
  token: string;
  freePlan?: boolean;
  // The effective workspace. Starts as the caller's session namespace and may be
  // rebound by adoptWorkspace when the request names an item that already
  // belongs somewhere else.
  sessionNamespace?: string;
  sessionUuid?: string;
};
