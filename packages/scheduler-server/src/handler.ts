/**
 * MCP Server 2 (Message Scheduler) Lambda handler (task 7.3).
 *
 * This single Lambda is **dual-triggered** and serves the two halves of MCP
 * Server 2 (design Component 2):
 *
 * 1. **EventBridge scheduled trigger (every 1 min) — the schedule check.** It
 *    loads the active webhook subscriptions, asks scheduler.ts (task 7.1) which
 *    of them are due to fire *now* via {@link dueSubscriptions}, and delivers a
 *    `briefing.trigger` MCP event to each due customer's webhook callback
 *    (Requirements 2.1, 2.2, 2.3).
 * 2. **API Gateway proxy trigger.** It serves two surfaces on the same Lambda:
 *    - the MCP HTTP transport (`POST /mcp`): the MCP Events protocol methods
 *      `events/list`, `events/subscribe`, and `events/unsubscribe` as JSON-RPC
 *      2.0 (Requirements 14.2, 14.3); and
 *    - the non-MCP REST manual trigger (`POST /trigger-briefing/{customerId}`):
 *      delivers a `briefing.trigger` immediately for one customer regardless of
 *      schedule (Requirement 2.4).
 *
 * This mirrors MCP Server 1 (usgs-server/handler.ts, task 6.5) almost exactly;
 * the differences are intentional and limited to this server's domain:
 * - the event type is `briefing.trigger` (not `earthquake.detected`), and its
 *   `inputSchema` advertises a `schedule` cron parameter (not earthquake
 *   filters);
 * - the EventBridge path runs a cron schedule check (scheduler.ts) instead of a
 *   USGS poll cycle; and
 * - it adds the manual `POST /trigger-briefing/{customerId}` REST route.
 *
 * Webhook secret handling (Requirements 14.5, 17.5): per the experimental MCP
 * Events extension webhook delivery mode, the Standard Webhooks signing secret
 * is **client-supplied per subscription** in `delivery.secret` (a `whsec_`
 * value). This server NEVER generates a secret and owns no per-server secret. On
 * `events/subscribe` it client-side encrypts the supplied secret with this
 * stack's customer-managed KMS key (bound to the `subscriptionId` via a KMS
 * encryption context) BEFORE writing it to the Subscriptions table, so DynamoDB
 * only ever holds ciphertext. It decrypts the secret in memory with
 * `kms:Decrypt` only when it needs to sign a delivery.
 *
 * Webhook delivery (Requirements 2.2, 14.4, 14.5): each delivery is an HTTP POST
 * to the subscription's `callbackUrl` carrying the `X-MCP-Subscription-Id`
 * routing header plus the three Standard Webhooks signature headers
 * (`webhook-id`, `webhook-timestamp`, `webhook-signature`) computed with the
 * `standardwebhooks` library over the exact serialized body, the same library
 * and approach the Webhook Receiver verifies with (webhook-receiver/signature.ts,
 * task 5.1). Failed deliveries are retried with exponential backoff, matching
 * MCP Server 1.
 *
 * Testability: orchestration is factored into small helpers and every
 * side-effecting dependency (the DynamoDB document client, the KMS client,
 * `fetch`, and `sleep`) is injectable through a `setXForTesting` seam, mirroring
 * usgs-server. Production code never calls the setters.
 */

import { randomUUID } from "node:crypto";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  BriefingTriggerData,
  McpEventPayload,
  SubscribeResult,
  WebhookSubscription,
} from "@mcp-events/shared";
import {
  DEFAULT_SUBSCRIPTION_TTL_SECONDS,
  EVENT_NAME_BRIEFING_TRIGGER,
  decryptSubscriptionSecret,
  encryptSubscriptionSecret,
  subscribeParamsSchema,
  uuidV4Schema,
} from "@mcp-events/shared";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { Webhook } from "standardwebhooks";

import { dueSubscriptions } from "./scheduler.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Routing header that selects a delivery's per-subscription secret. */
export const MCP_SUBSCRIPTION_ID_HEADER = "X-MCP-Subscription-Id";

/**
 * Exponential backoff schedule for webhook delivery retries: after the initial
 * attempt fails, retry up to three more times, waiting 1s, 5s, then 30s before
 * each retry. The total worst-case wait (~36s) stays inside the Webhook
 * Receiver's 5-minute Standard Webhooks timestamp tolerance, so the single
 * signature computed up front remains valid across all retries. Mirrors MCP
 * Server 1.
 */
export const WEBHOOK_RETRY_DELAYS_MS: readonly number[] = [1000, 5000, 30000];

/**
 * The `briefing.trigger` event type this server declares via `events/list`
 * (Requirement 14.2). The `inputSchema` advertises the cron `schedule`
 * parameter a client supplies in `events/subscribe.inputSchema`.
 */
export const BRIEFING_EVENT_TYPE = {
  name: EVENT_NAME_BRIEFING_TRIGGER,
  description:
    "Emitted per customer schedule to trigger earthquake briefing generation",
  inputSchema: {
    type: "object",
    properties: {
      schedule: {
        type: "string",
        description: "Cron expression for this customer's briefing schedule",
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// fetch / sleep injection seams (test seams; production uses the defaults)
// ---------------------------------------------------------------------------

/**
 * Minimal `fetch` signature covering the webhook delivery POST (which only
 * reads `.ok`/`.status`). Kept structurally compatible with the global `fetch`.
 */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/** Sleep abstraction so backoff waits can be faked (no real delays) in tests. */
export type SleepLike = (ms: number) => Promise<void>;

let fetchImpl: FetchLike = fetch as unknown as FetchLike;
let sleepImpl: SleepLike = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Override the `fetch` implementation used for webhook delivery. Test seam
 * only. Pass `undefined` to reset to the global `fetch`.
 */
export function setFetchForTesting(impl: FetchLike | undefined): void {
  fetchImpl = impl ?? (fetch as unknown as FetchLike);
}

/**
 * Override the `sleep` used between delivery retries. Test seam only, so tests
 * assert the backoff schedule without actually waiting 1s/5s/30s. Pass
 * `undefined` to reset to the real timer-based sleep.
 */
export function setSleepForTesting(impl: SleepLike | undefined): void {
  sleepImpl =
    impl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

// ---------------------------------------------------------------------------
// DynamoDB document client (lazy singleton + test seam)
// ---------------------------------------------------------------------------

let documentClient: DynamoDBDocumentClient | undefined;

/** Return the shared {@link DynamoDBDocumentClient}, creating it on first use. */
function getDocumentClient(): DynamoDBDocumentClient {
  if (!documentClient) {
    documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return documentClient;
}

/**
 * Override the DynamoDB document client. Test seam only. Pass `undefined` to
 * reset back to the lazily-created client.
 */
export function setDocumentClientForTesting(
  client: DynamoDBDocumentClient | undefined,
): void {
  documentClient = client;
}

// ---------------------------------------------------------------------------
// KMS client (lazy singleton + test seam)
// ---------------------------------------------------------------------------

let kmsClient: KMSClient | undefined;

/** Return the shared {@link KMSClient}, creating it on first use. */
function getKmsClient(): KMSClient {
  if (!kmsClient) {
    kmsClient = new KMSClient({});
  }
  return kmsClient;
}

/**
 * Override the KMS client. Test seam only. Pass `undefined` to reset back to
 * the lazily-created client.
 */
export function setKmsClientForTesting(client: KMSClient | undefined): void {
  kmsClient = client;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** Resolve the Subscriptions table name from the environment. */
function subscriptionsTableName(): string {
  const name = process.env.SUBSCRIPTIONS_TABLE_NAME;
  if (!name) {
    throw new Error("SUBSCRIPTIONS_TABLE_NAME is not set");
  }
  return name;
}

/** Resolve the KMS key id/arn used to encrypt subscription secrets. */
function secretKeyId(): string {
  const keyId = process.env.SUBSCRIPTION_SECRET_KEY_ID;
  if (!keyId) {
    throw new Error("SUBSCRIPTION_SECRET_KEY_ID is not set");
  }
  return keyId;
}

/**
 * This server's own MCP endpoint, recorded on each subscription as
 * `serverEndpoint`. Optional: the stored value is informational (the schedule
 * check path never reads it), so it falls back to the custom-domain identifier
 * when the stack does not inject `MCP_SERVER_ENDPOINT`.
 */
function serverEndpoint(): string {
  return (
    process.env.MCP_SERVER_ENDPOINT ?? "https://scheduler-mcp.earthquake-agent"
  );
}

// ---------------------------------------------------------------------------
// Subscription lifecycle (create, refresh, expire)
// ---------------------------------------------------------------------------

/**
 * The Subscriptions table item this server writes. It is structurally a
 * {@link WebhookSubscription} plus the numeric `ttl` attribute DynamoDB uses to
 * auto-expire stale rows. `customerId` is optional here because the MCP Events
 * `events/subscribe` protocol does not carry it; the Subscription Manager
 * supplies it as an extension field so this server can stamp each
 * `briefing.trigger` event's `data.customerId`. When absent, a scheduled
 * delivery for that subscription is skipped (it cannot build a valid event).
 */
type StoredSubscription = Omit<WebhookSubscription, "customerId"> & {
  customerId?: string;
  /** DynamoDB TTL, epoch seconds, mirrors `expiresAt`. */
  ttl: number;
};

/** Whether a subscription is currently eligible to receive deliveries. */
function isSubscriptionActive(
  subscription: WebhookSubscription,
  nowMs: number,
): boolean {
  return (
    subscription.status === "active" &&
    Date.parse(subscription.expiresAt) > nowMs
  );
}

/**
 * Load every subscription from the table and keep only those that are currently
 * active and not yet expired. Demo-scale single Scan, a production server would
 * page / use a status GSI.
 */
export async function loadActiveSubscriptions(
  nowMs: number,
): Promise<WebhookSubscription[]> {
  const result = await getDocumentClient().send(
    new ScanCommand({ TableName: subscriptionsTableName() }),
  );
  const items = (result.Items ?? []) as WebhookSubscription[];
  return items.filter((item) => isSubscriptionActive(item, nowMs));
}

/** Parsed `events/subscribe` inputs needed to build a subscription record. */
interface SubscribeInputs {
  event: WebhookSubscription["eventName"];
  callbackUrl: string;
  secret: string;
  schedule?: string;
  ttlSeconds: number;
  customerId?: string;
}

/**
 * Create a subscription on `events/subscribe` (Requirements 14.3, 14.5, 17.5):
 * mint a fresh `subscriptionId`, KMS-encrypt the client-supplied secret bound to
 * that id, persist an active {@link StoredSubscription} carrying the customer's
 * cron schedule, and return the {@link SubscribeResult}. The server stores and
 * later signs with the supplied secret; it never generates one.
 */
export async function createSubscription(
  inputs: SubscribeInputs,
  now: Date = new Date(),
): Promise<SubscribeResult> {
  const subscriptionId = randomUUID();
  const expiresAtMs = now.getTime() + inputs.ttlSeconds * 1000;
  const expiresAt = new Date(expiresAtMs).toISOString();
  const nowIso = now.toISOString();

  const encryptedSecret = await encryptSubscriptionSecret(
    getKmsClient(),
    secretKeyId(),
    subscriptionId,
    inputs.secret,
  );

  const record: StoredSubscription = {
    subscriptionId,
    ...(inputs.customerId !== undefined
      ? { customerId: inputs.customerId }
      : {}),
    serverEndpoint: serverEndpoint(),
    eventName: inputs.event,
    callbackUrl: inputs.callbackUrl,
    encryptedSecret,
    ...(inputs.schedule !== undefined ? { schedule: inputs.schedule } : {}),
    createdAt: nowIso,
    expiresAt,
    lastRefreshedAt: nowIso,
    status: "active",
    ttl: Math.floor(expiresAtMs / 1000),
  };

  await getDocumentClient().send(
    new PutCommand({
      TableName: subscriptionsTableName(),
      Item: record,
    }),
  );

  return { subscriptionId, expiresAt };
}

/**
 * Refresh an existing subscription's lifetime: extend `expiresAt`/`ttl`, bump
 * `lastRefreshedAt`, and (re)set `status` to active on a record that still
 * exists. Returns the new `expiresAt`, or `undefined` when the subscription is
 * gone (so the caller can re-create it).
 */
export async function refreshSubscription(
  subscriptionId: string,
  ttlSeconds: number = DEFAULT_SUBSCRIPTION_TTL_SECONDS,
  now: Date = new Date(),
): Promise<string | undefined> {
  const expiresAtMs = now.getTime() + ttlSeconds * 1000;
  const expiresAt = new Date(expiresAtMs).toISOString();

  try {
    await getDocumentClient().send(
      new UpdateCommand({
        TableName: subscriptionsTableName(),
        Key: { subscriptionId },
        UpdateExpression:
          "SET expiresAt = :e, #ttl = :t, lastRefreshedAt = :r, #status = :s",
        ConditionExpression: "attribute_exists(subscriptionId)",
        ExpressionAttributeNames: { "#ttl": "ttl", "#status": "status" },
        ExpressionAttributeValues: {
          ":e": expiresAt,
          ":t": Math.floor(expiresAtMs / 1000),
          ":r": now.toISOString(),
          ":s": "active",
        },
      }),
    );
    return expiresAt;
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "ConditionalCheckFailedException"
    ) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Remove a subscription on `events/unsubscribe`. DeleteItem is idempotent, so
 * unsubscribing an already-absent subscription is a no-op success.
 */
export async function deleteSubscription(
  subscriptionId: string,
): Promise<void> {
  await getDocumentClient().send(
    new DeleteCommand({
      TableName: subscriptionsTableName(),
      Key: { subscriptionId },
    }),
  );
}

// ---------------------------------------------------------------------------
// Webhook delivery (sign + POST + retry with backoff)
// ---------------------------------------------------------------------------

/** Build the `briefing.trigger` MCP event payload for one customer. */
export function buildBriefingEvent(
  data: BriefingTriggerData,
  now: Date = new Date(),
): McpEventPayload<BriefingTriggerData> {
  return {
    eventId: randomUUID(),
    name: EVENT_NAME_BRIEFING_TRIGGER,
    timestamp: now.toISOString(),
    data,
    // Opaque ordering/resumption cursor; (customer, scheduled minute) is stable.
    cursor: `${data.customerId}:${data.scheduledTime}`,
  };
}

/**
 * Compute the Standard Webhooks signature headers for a serialized payload and
 * a per-subscription `whsec_` secret, using the `standardwebhooks` library, the
 * same library/scheme the Webhook Receiver verifies with (task 5.1). Mirrors
 * `usgs-server/handler.ts:signDeliveryHeaders` (the receiver package is not a
 * dependency here, so each Lambda bundles the shared library independently).
 */
export function signDeliveryHeaders(
  payload: string,
  secret: string,
  now: Date = new Date(),
): {
  "webhook-id": string;
  "webhook-timestamp": string;
  "webhook-signature": string;
} {
  const webhook = new Webhook(secret);
  const msgId = `msg_${randomUUID()}`;
  const signature = webhook.sign(msgId, now, payload);
  return {
    "webhook-id": msgId,
    "webhook-timestamp": String(Math.floor(now.getTime() / 1000)),
    "webhook-signature": signature,
  };
}

/** Outcome of a delivery attempt sequence. */
export interface DeliveryOutcome {
  delivered: boolean;
  /** Total number of HTTP attempts made (1 initial + up to 3 retries). */
  attempts: number;
  /** The `eventId` of the `briefing.trigger` event that was delivered. */
  eventId: string;
}

/**
 * Deliver one `briefing.trigger` to one subscription as a signed webhook
 * (Requirements 2.2, 14.4, 14.5), retrying with exponential backoff on failure.
 *
 * The subscription's secret is decrypted once, the payload serialized once, and
 * the signature computed once up front so every retry sends byte-identical,
 * still-in-tolerance content. A non-2xx response or a thrown network error
 * counts as a failed attempt; between attempts the function sleeps for the next
 * {@link WEBHOOK_RETRY_DELAYS_MS} delay via the injected {@link SleepLike}.
 */
export async function deliverBriefing(
  subscription: WebhookSubscription,
  data: BriefingTriggerData,
  now: Date = new Date(),
): Promise<DeliveryOutcome> {
  const secret = await decryptSubscriptionSecret(
    getKmsClient(),
    subscription.subscriptionId,
    subscription.encryptedSecret,
  );

  const event = buildBriefingEvent(data, now);
  const payload = JSON.stringify(event);
  const signatureHeaders = signDeliveryHeaders(payload, secret, now);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [MCP_SUBSCRIPTION_ID_HEADER]: subscription.subscriptionId,
    ...signatureHeaders,
  };

  // 1 initial attempt + one retry per backoff delay.
  const maxAttempts = WEBHOOK_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let succeeded = false;
    try {
      const response = await fetchImpl(subscription.callbackUrl, {
        method: "POST",
        headers,
        body: payload,
      });
      succeeded = response.ok;
      if (!succeeded) {
        console.warn("Webhook delivery returned non-2xx", {
          subscriptionId: subscription.subscriptionId,
          status: response.status,
          attempt: attempt + 1,
        });
      }
    } catch (error) {
      console.warn("Webhook delivery threw", {
        subscriptionId: subscription.subscriptionId,
        attempt: attempt + 1,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (succeeded) {
      return { delivered: true, attempts: attempt + 1, eventId: event.eventId };
    }

    // Back off before the next retry (no wait after the final attempt).
    if (attempt < WEBHOOK_RETRY_DELAYS_MS.length) {
      await sleepImpl(WEBHOOK_RETRY_DELAYS_MS[attempt]);
    }
  }

  return { delivered: false, attempts: maxAttempts, eventId: event.eventId };
}

// ---------------------------------------------------------------------------
// Schedule check orchestration (EventBridge trigger)
// ---------------------------------------------------------------------------

/** Summary of a single schedule check, returned for logging / tests. */
export interface ScheduleCheckSummary {
  activeSubscriptions: number;
  due: number;
  delivered: number;
  failed: number;
}

/**
 * Run one schedule check (Requirements 2.1, 2.2, 2.3): load active
 * subscriptions, ask scheduler.ts which are due now, and deliver a scheduled
 * `briefing.trigger` to each. Each customer is evaluated and delivered
 * independently, so one customer's non-match or delivery failure never affects
 * another (Requirement 2.3).
 */
export async function runScheduleCheck(
  now: Date = new Date(),
): Promise<ScheduleCheckSummary> {
  const subscriptions = await loadActiveSubscriptions(now.getTime());
  const due = dueSubscriptions(subscriptions, now);

  let delivered = 0;
  let failed = 0;
  for (const subscription of due) {
    if (!subscription.customerId) {
      // A briefing.trigger subscription with no customerId cannot populate a
      // valid event payload; skip it rather than failing the whole tick. The
      // Subscription Manager always supplies customerId for this server.
      console.warn("Skipping due subscription with no customerId", {
        subscriptionId: subscription.subscriptionId,
      });
      continue;
    }

    const data: BriefingTriggerData = {
      triggerType: "scheduled",
      customerId: subscription.customerId,
      scheduledTime: now.toISOString(),
    };
    const outcome = await deliverBriefing(subscription, data, now);
    if (outcome.delivered) {
      delivered += 1;
    } else {
      failed += 1;
    }
  }

  return {
    activeSubscriptions: subscriptions.length,
    due: due.length,
    delivered,
    failed,
  };
}

// ---------------------------------------------------------------------------
// Manual trigger orchestration (REST: POST /trigger-briefing/{customerId})
// ---------------------------------------------------------------------------

/** Response of the manual trigger endpoint (the ManualTriggerEndpoint contract). */
export interface ManualTriggerResult {
  eventId: string;
  delivered: boolean;
}

/**
 * Deliver a manual `briefing.trigger` for one customer immediately, regardless
 * of schedule (Requirement 2.4). Finds that customer's active briefing
 * subscriptions and delivers a manual-type trigger to each (normally exactly
 * one). Returns the delivered event's id and whether any delivery succeeded;
 * when the customer has no active briefing subscription, returns a fresh id with
 * `delivered: false`.
 */
export async function triggerBriefingForCustomer(
  customerId: string,
  reason: string | undefined,
  now: Date = new Date(),
): Promise<ManualTriggerResult> {
  const subscriptions = await loadActiveSubscriptions(now.getTime());
  const matching = subscriptions.filter(
    (subscription) =>
      subscription.eventName === EVENT_NAME_BRIEFING_TRIGGER &&
      subscription.customerId === customerId,
  );

  if (matching.length === 0) {
    console.warn("Manual trigger found no active subscription for customer", {
      customerId,
    });
    return { eventId: randomUUID(), delivered: false };
  }

  const data: BriefingTriggerData = {
    triggerType: "manual",
    customerId,
    scheduledTime: now.toISOString(),
    ...(reason !== undefined ? { reason } : {}),
  };

  let delivered = false;
  let eventId: string | undefined;
  for (const subscription of matching) {
    const outcome = await deliverBriefing(subscription, data, now);
    eventId ??= outcome.eventId;
    if (outcome.delivered) {
      delivered = true;
    }
  }

  return { eventId: eventId ?? randomUUID(), delivered };
}

// ---------------------------------------------------------------------------
// HTTP plumbing shared by both API Gateway surfaces
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

/** Read the raw request body, decoding API Gateway base64 bodies. */
function readRawBody(event: APIGatewayProxyEvent): string {
  if (event.body === null || event.body === undefined) {
    return "";
  }
  return event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
}

/** Best-effort JSON parse; returns `undefined` when the text is not JSON. */
function tryParseJson(text: string): unknown {
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// MCP protocol (JSON-RPC 2.0 over API Gateway)
// ---------------------------------------------------------------------------

/** Standard JSON-RPC 2.0 error codes used by the MCP transport. */
const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_INTERNAL_ERROR = -32603;

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

/** Build an API Gateway response carrying a JSON-RPC success result. */
function jsonRpcResult(id: JsonRpcId, result: unknown): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id, result }),
  };
}

/** Build an API Gateway response carrying a JSON-RPC error object. */
function jsonRpcErrorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }),
  };
}

/**
 * Extract an optional `customerId` extension field from raw subscribe params.
 * The MCP Events protocol does not define it, so it is accepted only when
 * present and a valid UUID v4; an invalid value is reported as invalid params.
 */
function extractCustomerId(params: unknown): {
  ok: boolean;
  customerId?: string;
} {
  if (
    typeof params !== "object" ||
    params === null ||
    !("customerId" in params)
  ) {
    return { ok: true };
  }
  const value = (params as { customerId?: unknown }).customerId;
  if (value === undefined) {
    return { ok: true };
  }
  const parsed = uuidV4Schema.safeParse(value);
  return parsed.success ? { ok: true, customerId: parsed.data } : { ok: false };
}

/** Handle `events/list` (Requirement 14.2). */
function handleEventsList(id: JsonRpcId): APIGatewayProxyResult {
  return jsonRpcResult(id, { eventTypes: [BRIEFING_EVENT_TYPE] });
}

/**
 * Handle `events/subscribe` (Requirements 14.3, 14.5, 17.5). Validates the
 * params with the shared zod schema (including the required `whsec_` secret
 * format), rejects events other than `briefing.trigger`, maps `inputSchema` to
 * the cron schedule, and creates the subscription.
 */
async function handleEventsSubscribe(
  id: JsonRpcId,
  params: unknown,
): Promise<APIGatewayProxyResult> {
  const parsed = subscribeParamsSchema.safeParse(params);
  if (!parsed.success) {
    return jsonRpcErrorResponse(
      id,
      JSON_RPC_INVALID_PARAMS,
      `Invalid events/subscribe params: ${parsed.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }

  const data = parsed.data;
  if (data.event !== EVENT_NAME_BRIEFING_TRIGGER) {
    return jsonRpcErrorResponse(
      id,
      JSON_RPC_INVALID_PARAMS,
      `MCP Server 2 only emits ${EVENT_NAME_BRIEFING_TRIGGER}`,
    );
  }

  const customer = extractCustomerId(params);
  if (!customer.ok) {
    return jsonRpcErrorResponse(
      id,
      JSON_RPC_INVALID_PARAMS,
      "customerId must be a valid UUID v4 when supplied",
    );
  }

  const result = await createSubscription({
    event: data.event,
    callbackUrl: data.delivery.url,
    secret: data.delivery.secret,
    schedule: data.inputSchema?.schedule,
    ttlSeconds: data.ttl ?? DEFAULT_SUBSCRIPTION_TTL_SECONDS,
    customerId: customer.customerId,
  });

  return jsonRpcResult(id, result);
}

/** Handle `events/unsubscribe`, validate the id and delete the record. */
async function handleEventsUnsubscribe(
  id: JsonRpcId,
  params: unknown,
): Promise<APIGatewayProxyResult> {
  const subscriptionId =
    typeof params === "object" && params !== null
      ? (params as { subscriptionId?: unknown }).subscriptionId
      : undefined;

  const parsed = uuidV4Schema.safeParse(subscriptionId);
  if (!parsed.success) {
    return jsonRpcErrorResponse(
      id,
      JSON_RPC_INVALID_PARAMS,
      "subscriptionId must be a valid UUID v4",
    );
  }

  await deleteSubscription(parsed.data);
  return jsonRpcResult(id, { unsubscribed: true });
}

/**
 * Dispatch a single MCP JSON-RPC request to the matching `events/*` method.
 * Application-level failures are returned as JSON-RPC error objects (HTTP 200),
 * matching JSON-RPC semantics; only an unparseable body yields a transport-level
 * error.
 */
async function handleMcpRequest(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  if (event.httpMethod.toUpperCase() !== "POST") {
    return jsonRpcErrorResponse(
      null,
      JSON_RPC_INVALID_REQUEST,
      "MCP transport accepts POST only",
    );
  }

  const raw = readRawBody(event);
  if (raw.length === 0) {
    return jsonRpcErrorResponse(
      null,
      JSON_RPC_INVALID_REQUEST,
      "Empty request",
    );
  }

  let request: JsonRpcRequest;
  try {
    request = JSON.parse(raw) as JsonRpcRequest;
  } catch {
    return jsonRpcErrorResponse(null, JSON_RPC_PARSE_ERROR, "Invalid JSON");
  }

  const id: JsonRpcId =
    typeof request.id === "string" ||
    typeof request.id === "number" ||
    request.id === null
      ? request.id
      : null;

  if (typeof request.method !== "string") {
    return jsonRpcErrorResponse(
      id,
      JSON_RPC_INVALID_REQUEST,
      "Missing JSON-RPC method",
    );
  }

  switch (request.method) {
    case "events/list":
      return handleEventsList(id);
    case "events/subscribe":
      return handleEventsSubscribe(id, request.params);
    case "events/unsubscribe":
      return handleEventsUnsubscribe(id, request.params);
    default:
      return jsonRpcErrorResponse(
        id,
        JSON_RPC_METHOD_NOT_FOUND,
        `Unknown method ${request.method}`,
      );
  }
}

// ---------------------------------------------------------------------------
// Manual trigger REST surface (POST /trigger-briefing/{customerId})
// ---------------------------------------------------------------------------

/** Whether the API Gateway request targets the manual trigger REST route. */
function isTriggerBriefingRequest(event: APIGatewayProxyEvent): boolean {
  const route = event.resource || event.path || "";
  return route.includes("/trigger-briefing/");
}

/**
 * Extract the `customerId` for the manual trigger route, preferring the
 * API Gateway path parameter and falling back to parsing the raw path.
 */
function triggerCustomerId(event: APIGatewayProxyEvent): string | undefined {
  const fromParams = event.pathParameters?.customerId;
  if (fromParams) {
    return fromParams;
  }
  const match = /\/trigger-briefing\/([^/]+)/.exec(event.path ?? "");
  return match ? decodeURIComponent(match[1]) : undefined;
}

/** Extract an optional string `reason` from a parsed JSON body. */
function extractReason(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null && "reason" in body) {
    const reason = (body as { reason?: unknown }).reason;
    if (typeof reason === "string") {
      return reason;
    }
  }
  return undefined;
}

/**
 * Serve `POST /trigger-briefing/{customerId}` (Requirement 2.4). Validates the
 * customerId path parameter, reads an optional `reason` from the body, and
 * delivers a manual `briefing.trigger`. Returns 200 with the
 * `{ eventId, delivered }` contract, or 400 on a malformed customerId.
 */
async function handleManualTrigger(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  if (event.httpMethod.toUpperCase() !== "POST") {
    return {
      statusCode: 405,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: "trigger-briefing accepts POST only" }),
    };
  }

  const parsed = uuidV4Schema.safeParse(triggerCustomerId(event));
  if (!parsed.success) {
    return {
      statusCode: 400,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: "customerId must be a valid UUID v4" }),
    };
  }

  const reason = extractReason(tryParseJson(readRawBody(event)));
  const result = await triggerBriefingForCustomer(parsed.data, reason);

  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify(result),
  };
}

// ---------------------------------------------------------------------------
// Lambda entry point (dual trigger)
// ---------------------------------------------------------------------------

/** Whether the invocation is an API Gateway proxy event (vs an EventBridge tick). */
function isApiGatewayEvent(event: unknown): event is APIGatewayProxyEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    typeof (event as { httpMethod?: unknown }).httpMethod === "string"
  );
}

/**
 * Dual-trigger Lambda entry point. An API Gateway proxy event is served either
 * as the manual trigger REST route or as the MCP HTTP transport; anything else
 * (the EventBridge scheduled tick) runs a schedule check. The schedule-check
 * path returns no HTTP result.
 */
export async function handler(
  event: unknown,
): Promise<APIGatewayProxyResult | void> {
  if (isApiGatewayEvent(event)) {
    if (isTriggerBriefingRequest(event)) {
      try {
        return await handleManualTrigger(event);
      } catch (error) {
        console.error("Unhandled manual trigger error", error);
        return {
          statusCode: 500,
          headers: JSON_HEADERS,
          body: JSON.stringify({ error: "Internal Server Error" }),
        };
      }
    }

    try {
      return await handleMcpRequest(event);
    } catch (error) {
      console.error("Unhandled MCP request error", error);
      return jsonRpcErrorResponse(
        null,
        JSON_RPC_INTERNAL_ERROR,
        "Internal Server Error",
      );
    }
  }

  await runScheduleCheck();
}
