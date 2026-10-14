// Typed errors raised by core operations. Each adapter (GraphQL today; MCP and
// REST later) decides how they reach its callers, so core never encodes a wire
// format. The messages are the ones the console has always shown.

export class ForbiddenError extends Error {
  readonly code = "forbidden";
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends Error {
  readonly code = "not_found";
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

// Free-plan (anonymous) principals may not use full-account features. Each
// operation that needs a full account calls this first, so a transport can't
// reach the operation without the check.
export function requireFullAccount(auth: { freePlan?: boolean } | null | undefined, feature: "connections" | "sharing" | "history") {
  if (!auth?.freePlan) return;
  const message = {
    connections: "Connections require a full account.",
    sharing: "Sharing requires a full account.",
    history: "Version history requires a full account.",
  }[feature];
  throw new ForbiddenError(message);
}
