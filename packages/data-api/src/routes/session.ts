/**
 * Read-only session messages route handler (task 4.6).
 *
 * Route: GET /customers/:customerId/session/messages
 *
 * Reads the agent's session snapshot from the sessions S3 bucket at the SDK
 * snapshot key
 * `sessions/{customerId}/scopes/agent/agent/snapshots/snapshot_latest.json`
 * (read-only `s3:GetObject`) and returns the conversation history as
 * `{ messages: [...] }` (Requirements 9.8, 10.7).
 *
 * The sessions bucket is owned by AgentStack; the agent writes it directly via
 * the Strands SDK `SessionManager` + `S3Storage`. The Data API only ever reads
 * it (the CDK stack grants `s3:GetObject` on the `sessions/` prefix and passes
 * the bucket name via the `SESSIONS_BUCKET_NAME` environment variable).
 *
 * Resilience:
 * - Missing snapshot (S3 `NoSuchKey` / 404) -> 200 with `{ messages: [] }` so a
 *   customer who has not yet been processed still renders an empty timeline.
 * - Malformed JSON -> 200 with `{ messages: [] }`. The webapp's conversation
 *   view (Requirement 10.7) auto-refreshes every 30 seconds, so degrading to an
 *   empty list keeps the UI resilient rather than surfacing a 500 for a
 *   transient half-written object.
 *
 * Authorization (Cognito caller's `sub` == `customerId`, or an IAM backend
 * caller) is enforced by the handler before dispatch, so this handler focuses
 * on the read. `customerId` is still validated as a UUID v4 here to reject
 * malformed input and prevent S3 key injection.
 */

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { ConversationMessage } from "@mcp-events/shared";
import { uuidV4Schema } from "@mcp-events/shared";

import { badRequest } from "../http.js";
import type { ApiResult, RouteContext } from "../types.js";

/**
 * Lazily-created S3 client. A module-level singleton so the Lambda reuses one
 * client across warm invocations (mirrors the config route's DynamoDB client).
 */
let s3Client: S3Client | undefined;

/** Return the shared {@link S3Client}, creating it on first use. */
function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({});
  }
  return s3Client;
}

/**
 * Override the S3 client. Test seam only — production code never calls this.
 * Pass `undefined` to reset back to the lazily-created client.
 */
export function setS3ClientForTesting(client: S3Client | undefined): void {
  s3Client = client;
}

/** Resolve the sessions bucket name from the environment. */
function sessionsBucketName(): string {
  const name = process.env.SESSIONS_BUCKET_NAME;
  if (!name) {
    // Misconfiguration — surfaces as a 500 via the handler's catch-all.
    throw new Error("SESSIONS_BUCKET_NAME is not set");
  }
  return name;
}

/** Build the S3 object key for a customer's session snapshot. */
function sessionKey(customerId: string): string {
  return `sessions/${customerId}/scopes/agent/agent/snapshots/snapshot_latest.json`;
}

/**
 * Validate and return the `customerId` path parameter.
 *
 * @throws HttpError 400 when it is missing or not a UUID v4 (Requirement 16.1).
 */
function requireCustomerId(ctx: RouteContext): string {
  const result = uuidV4Schema.safeParse(ctx.pathParameters.customerId);
  if (!result.success) {
    throw badRequest("customerId must be a valid UUID v4");
  }
  return result.data;
}

/** True when an S3 error represents a missing object/bucket or a 404 response. */
function isNotFoundError(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const candidate = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  if (
    typeof candidate.name === "string" &&
    (candidate.name === "NoSuchKey" || candidate.name === "NoSuchBucket")
  ) {
    return true;
  }
  return candidate.$metadata?.httpStatusCode === 404;
}

/**
 * Extract the conversation history from a parsed session snapshot.
 *
 * The snapshot may take either of two shapes depending on how it was written:
 * - the application-level {@link AgentSessionState} shape with a top-level
 *   `messages` array, or
 * - the Strands SDK `Snapshot` shape, which nests the conversation under
 *   `data.messages`.
 *
 * The messages are passed through opaquely (their per-message content mirrors
 * the SDK / {@link ConversationMessage} shape); anything else yields an empty
 * array so the caller always receives a well-formed `messages` list.
 */
function extractMessages(snapshot: unknown): ConversationMessage[] {
  if (snapshot === null || typeof snapshot !== "object") {
    return [];
  }
  const root = snapshot as Record<string, unknown>;

  // Application-level AgentSessionState shape: top-level `messages`.
  if (Array.isArray(root.messages)) {
    return root.messages as ConversationMessage[];
  }

  // Strands SDK Snapshot shape: framework state under `data`, messages nested.
  const data = root.data;
  if (data !== null && typeof data === "object") {
    const nested = (data as Record<string, unknown>).messages;
    if (Array.isArray(nested)) {
      return nested as ConversationMessage[];
    }
  }

  return [];
}

/**
 * GET /customers/:customerId/session/messages — return the agent's conversation
 * history for a customer (task 4.6).
 *
 * Reads `sessions/{customerId}/scopes/agent/agent/snapshots/snapshot_latest.json`
 * from the sessions bucket and returns `{ messages: [...] }`. Returns an empty
 * list (still 200) when the snapshot is absent or unparseable so the webapp
 * view stays resilient.
 */
export async function getSessionMessages(
  ctx: RouteContext,
): Promise<ApiResult> {
  const customerId = requireCustomerId(ctx);

  let body: string | undefined;
  try {
    const result = await getS3Client().send(
      new GetObjectCommand({
        Bucket: sessionsBucketName(),
        Key: sessionKey(customerId),
      }),
    );
    body = await result.Body?.transformToString();
  } catch (error) {
    if (isNotFoundError(error)) {
      // No session yet for this customer — return an empty timeline.
      return { statusCode: 200, body: { messages: [] } };
    }
    throw error;
  }

  if (!body) {
    return { statusCode: 200, body: { messages: [] } };
  }

  let snapshot: unknown;
  try {
    snapshot = JSON.parse(body);
  } catch {
    // Half-written / corrupted snapshot — stay resilient with an empty list.
    return { statusCode: 200, body: { messages: [] } };
  }

  return { statusCode: 200, body: { messages: extractMessages(snapshot) } };
}
