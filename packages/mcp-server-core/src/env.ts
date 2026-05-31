/**
 * Environment lookups shared by both MCP servers.
 *
 * The Subscriptions table name and the subscription-secret KMS key id are
 * required at runtime and throw when unset (a misconfiguration surfaces as a
 * failed invocation rather than silently misbehaving). The server endpoint is
 * informational and falls back to a per-server default the caller supplies.
 */

/** Resolve the Subscriptions table name from the environment. */
export function subscriptionsTableName(): string {
  const name = process.env.SUBSCRIPTIONS_TABLE_NAME;
  if (!name) {
    throw new Error("SUBSCRIPTIONS_TABLE_NAME is not set");
  }
  return name;
}

/** Resolve the KMS key id/arn used to encrypt subscription secrets. */
export function secretKeyId(): string {
  const keyId = process.env.SUBSCRIPTION_SECRET_KEY_ID;
  if (!keyId) {
    throw new Error("SUBSCRIPTION_SECRET_KEY_ID is not set");
  }
  return keyId;
}

/**
 * This server's own MCP endpoint, recorded on each subscription as
 * `serverEndpoint`. Optional: the stored value is informational (the poll /
 * schedule-check paths never read it), so it falls back to the caller-supplied
 * per-server identifier when the stack does not inject `MCP_SERVER_ENDPOINT`.
 */
export function serverEndpoint(fallback: string): string {
  return process.env.MCP_SERVER_ENDPOINT ?? fallback;
}
