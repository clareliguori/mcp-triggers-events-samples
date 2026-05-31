/**
 * Event routing and customer resolution for the Serverless Agent (task 9.3).
 *
 * The agent is woken by SQS messages that the Webhook Receiver enqueued after
 * validating a Standard Webhooks delivery. Each message carries:
 * - the raw MCP event payload as the message **body** (an
 *   {@link McpEventPayload}: `earthquake.detected` or `briefing.trigger`), and
 * - the originating subscription id as the `subscriptionId` **message
 *   attribute** (see the Webhook Receiver handler, task 5.4).
 *
 * This module turns that raw SQS record into a {@link RoutedEvent} the rest of
 * the agent can act on (Requirement 4.1). It:
 *
 * 1. Extracts the `subscriptionId` from the message attributes and parses /
 *    validates the event body against the shared schema.
 * 2. Resolves the `subscriptionId` to a `customerId` by calling the Data API
 *    (`GET /subscriptions/{subscriptionId}`) over an IAM SigV4-signed HTTPS
 *    request (Requirement 4.1, 17.7) — the same signing approach the Webhook
 *    Receiver uses.
 * 3. Determines the event type (`earthquake.detected` vs `briefing.trigger`)
 *    from the validated payload.
 *
 * Error handling (Requirement 15.6, design Error Scenario 9): a missing
 * subscription-to-customer mapping (the Data API returns 404) is a **permanent**
 * error — retrying cannot fix it — so the record is sent straight to the
 * dead-letter queue for operator investigation rather than burning the SQS
 * retry budget. A structurally unusable record (no `subscriptionId` attribute,
 * or a body that is not a valid MCP event) is likewise permanent and
 * dead-lettered. By contrast, a transient Data API failure (timeout, 5xx) is
 * surfaced as a thrown error so the caller lets the SQS message return to the
 * queue and retry (design Error Scenario 10 uses the same retry path).
 *
 * The high-level {@link routeRecord} ties these together into a single
 * discriminated {@link RouteOutcome} so the Lambda handler (task 9.10) can:
 * - `"routed"`        -> acquire the lock and process the event,
 * - `"dead-lettered"` -> treat the message as handled (delete from the queue),
 * - thrown error      -> report a batch item failure (SQS retry).
 */

import { Sha256 } from "@aws-crypto/sha256-js";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import type { McpEventPayload } from "@mcp-events/shared";
import { mcpEventPayloadSchema } from "@mcp-events/shared";
import { SignatureV4 } from "@smithy/signature-v4";
import type { HttpRequest } from "@smithy/types";
import type { SQSRecord } from "aws-lambda";

/**
 * Name of the SQS message attribute that carries the originating subscription
 * id. Must match what the Webhook Receiver sets when enqueueing (task 5.4).
 */
export const SUBSCRIPTION_ID_ATTRIBUTE = "subscriptionId";

/** Event type names, derived from the validated payload's discriminant. */
export type EventType = McpEventPayload["name"];

/**
 * A fully resolved event: the subscription it arrived on, the customer it
 * belongs to, the event type, and the validated payload. This is everything
 * downstream processing (lock -> restore session -> invoke LLM) needs.
 */
export interface RoutedEvent {
  /** Subscription id from the SQS message attribute. */
  subscriptionId: string;
  /** Customer resolved from the subscription via the Data API. */
  customerId: string;
  /** `earthquake.detected` or `briefing.trigger`. */
  eventType: EventType;
  /** The validated MCP event payload parsed from the message body. */
  event: McpEventPayload;
}

/**
 * Result of routing a single SQS record.
 *
 * - `routed`: the event was resolved; act on `event`.
 * - `dead-lettered`: the record was permanently un-routable and has already
 *   been sent to the DLQ; the caller should delete it from the main queue.
 *
 * Transient failures are NOT represented here — they are thrown so the caller
 * can let SQS retry the message.
 */
export type RouteOutcome =
  | { status: "routed"; event: RoutedEvent }
  | { status: "dead-lettered"; reason: string };

// ---------------------------------------------------------------------------
// Data API subscription lookup (IAM SigV4)
// ---------------------------------------------------------------------------

/**
 * The outcome of a Data API subscription lookup: the downstream HTTP status and
 * raw response body. A 200 body is expected to be the Data API's subscription
 * JSON, which carries the `customerId` used for routing.
 */
export interface SubscriptionLookupResult {
  /** Downstream HTTP status code from the Data API. */
  statusCode: number;
  /** Raw response body text (may be empty). */
  body: string;
}

/**
 * Resolves a subscription record from the Data API. The production
 * implementation SigV4-signs `GET /subscriptions/{id}` and delivers it with
 * `fetch`; tests override it via {@link setSubscriptionLookupForTesting} so they
 * never sign or hit the network.
 */
export type SubscriptionLookup = (
  subscriptionId: string,
) => Promise<SubscriptionLookupResult>;

/** Resolve the Data API base URL from the environment (set by AgentStack). */
function dataApiUrl(): string {
  const url = process.env.DATA_API_URL;
  if (!url) {
    // Misconfiguration — surfaces as a thrown error so the message retries.
    throw new Error("DATA_API_URL is not set");
  }
  return url;
}

/** Resolve the signing region from the Lambda environment. */
function signingRegion(): string {
  return (
    process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1"
  );
}

/**
 * SigV4-sign `GET {DATA_API_URL}/subscriptions/{id}` for the `execute-api`
 * service and deliver it with the global `fetch` (Node 20+). Credentials come
 * from the Lambda execution role via the default provider chain. The Data API
 * returns the {@link WebhookSubscription} (including `customerId`) as JSON
 * (Requirement 4.1, 17.7).
 */
const defaultLookup: SubscriptionLookup = async (subscriptionId) => {
  const baseUrl = dataApiUrl().replace(/\/+$/, "");
  const target = `${baseUrl}/subscriptions/${encodeURIComponent(subscriptionId)}`;
  const url = new URL(target);

  const signer = new SignatureV4({
    service: "execute-api",
    region: signingRegion(),
    credentials: defaultProvider(),
    sha256: Sha256,
  });

  const toSign: HttpRequest = {
    method: "GET",
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname,
    // SigV4 sets the `host` header during signing; provide it explicitly too.
    headers: { host: url.host, accept: "application/json" },
    body: undefined,
  };

  const signed = await signer.sign(toSign);

  const response = await fetch(target, {
    method: "GET",
    headers: signed.headers,
  });

  return { statusCode: response.status, body: await response.text() };
};

/** Module-level lookup singleton (test seam). */
let lookup: SubscriptionLookup = defaultLookup;

/**
 * Override the Data API {@link SubscriptionLookup}. Test seam only — production
 * code never calls this. Pass `undefined` to reset back to the default SigV4
 * implementation.
 */
export function setSubscriptionLookupForTesting(
  override: SubscriptionLookup | undefined,
): void {
  lookup = override ?? defaultLookup;
}

// ---------------------------------------------------------------------------
// Dead-letter queue client
// ---------------------------------------------------------------------------

/** Message attribute name carrying the reason a record was dead-lettered. */
export const DLQ_REASON_ATTRIBUTE = "dlqReason";

/** Lazily-created SQS client, reused across warm invocations. */
let sqsClient: SQSClient | undefined;

/** Return the shared {@link SQSClient}, creating it on first use. */
function getSqsClient(): SQSClient {
  if (!sqsClient) {
    sqsClient = new SQSClient({});
  }
  return sqsClient;
}

/**
 * Override the SQS client. Test seam only — production code never calls this.
 * Pass `undefined` to reset back to the lazily-created client.
 */
export function setSqsClientForTesting(client: SQSClient | undefined): void {
  sqsClient = client;
}

/** Resolve the dead-letter queue URL from the environment (set by AgentStack). */
function deadLetterQueueUrl(): string {
  const url = process.env.DEAD_LETTER_QUEUE_URL;
  if (!url) {
    // Misconfiguration — surfaces as a thrown error so the message retries.
    throw new Error("DEAD_LETTER_QUEUE_URL is not set");
  }
  return url;
}

// ---------------------------------------------------------------------------
// SQS record parsing
// ---------------------------------------------------------------------------

/**
 * Thrown when an SQS record is structurally unusable: it has no
 * `subscriptionId` attribute, or its body is missing / not a valid MCP event
 * payload. These are permanent failures (retrying cannot fix them), so the
 * caller dead-letters the record.
 */
export class MalformedMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedMessageError";
  }
}

/**
 * Thrown when a subscription id cannot be resolved to a customer because the
 * Data API reports the subscription is unknown (404). Permanent failure —
 * the caller dead-letters the record (Requirement 15.6, Error Scenario 9).
 */
export class SubscriptionNotFoundError extends Error {
  constructor(public readonly subscriptionId: string) {
    super(`No customer mapping for subscription ${subscriptionId}`);
    this.name = "SubscriptionNotFoundError";
  }
}

/** The structural pieces extracted from an SQS record before resolution. */
interface ParsedRecord {
  subscriptionId: string;
  event: McpEventPayload;
}

/**
 * Extract the `subscriptionId` message attribute from an SQS record.
 *
 * @throws MalformedMessageError when the attribute is absent or has no string
 *   value.
 */
function extractSubscriptionId(record: SQSRecord): string {
  const attribute = record.messageAttributes?.[SUBSCRIPTION_ID_ATTRIBUTE];
  const value = attribute?.stringValue;
  if (typeof value !== "string" || value.length === 0) {
    throw new MalformedMessageError(
      `SQS record ${record.messageId} is missing the ${SUBSCRIPTION_ID_ATTRIBUTE} message attribute`,
    );
  }
  return value;
}

/**
 * Parse and validate the MCP event payload from an SQS record body.
 *
 * @throws MalformedMessageError when the body is not JSON or does not match the
 *   shared {@link mcpEventPayloadSchema}.
 */
function parseEvent(record: SQSRecord): McpEventPayload {
  let json: unknown;
  try {
    json = JSON.parse(record.body) as unknown;
  } catch {
    throw new MalformedMessageError(
      `SQS record ${record.messageId} body is not valid JSON`,
    );
  }

  const parsed = mcpEventPayloadSchema.safeParse(json);
  if (!parsed.success) {
    throw new MalformedMessageError(
      `SQS record ${record.messageId} body is not a valid MCP event payload`,
    );
  }
  // The schema is a discriminated union over `name`, so the parsed value is a
  // valid McpEventPayload.
  return parsed.data as McpEventPayload;
}

/**
 * Parse an SQS record into its subscription id and validated event payload.
 *
 * @throws MalformedMessageError on a missing attribute or invalid body.
 */
export function parseRecord(record: SQSRecord): ParsedRecord {
  const subscriptionId = extractSubscriptionId(record);
  const event = parseEvent(record);
  return { subscriptionId, event };
}

// ---------------------------------------------------------------------------
// Customer resolution
// ---------------------------------------------------------------------------

/** Narrowly read a string `customerId` field off an unknown parsed body. */
function extractCustomerId(body: string): string | undefined {
  if (body.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "customerId" in parsed &&
    typeof (parsed as { customerId?: unknown }).customerId === "string"
  ) {
    return (parsed as { customerId: string }).customerId;
  }
  return undefined;
}

/**
 * Resolve a subscription id to its owning customer id via the Data API
 * (Requirement 4.1).
 *
 * @throws SubscriptionNotFoundError when the Data API reports the subscription
 *   is unknown (404) — a permanent failure routed to the DLQ.
 * @throws Error on a transient/upstream failure (non-2xx other than 404, or a
 *   2xx body without a usable `customerId`) so the caller lets SQS retry.
 */
export async function resolveCustomerId(
  subscriptionId: string,
): Promise<string> {
  const result = await lookup(subscriptionId);

  if (result.statusCode === 404) {
    throw new SubscriptionNotFoundError(subscriptionId);
  }
  if (result.statusCode < 200 || result.statusCode >= 300) {
    // Transient/upstream failure — throw so the message returns to the queue
    // and retries rather than being permanently dead-lettered.
    throw new Error(
      `Data API subscription lookup for ${subscriptionId} returned ${result.statusCode}`,
    );
  }

  const customerId = extractCustomerId(result.body);
  if (customerId === undefined) {
    // A 200 with no usable customerId is unexpected; treat as transient so we
    // retry rather than silently dropping a possibly-routable event.
    throw new Error(
      `Data API subscription lookup for ${subscriptionId} returned no customerId`,
    );
  }
  return customerId;
}

// ---------------------------------------------------------------------------
// Dead-lettering
// ---------------------------------------------------------------------------

/**
 * Send an un-routable SQS record to the dead-letter queue for investigation
 * (Requirement 15.6, Error Scenario 9). The original event body is preserved,
 * the `subscriptionId` attribute is carried over when present, and a
 * `dlqReason` attribute records why the record could not be processed.
 */
export async function sendToDeadLetterQueue(
  record: SQSRecord,
  reason: string,
): Promise<void> {
  const subscriptionId =
    record.messageAttributes?.[SUBSCRIPTION_ID_ATTRIBUTE]?.stringValue;

  const messageAttributes: SendMessageCommand["input"]["MessageAttributes"] = {
    [DLQ_REASON_ATTRIBUTE]: { DataType: "String", StringValue: reason },
  };
  if (typeof subscriptionId === "string" && subscriptionId.length > 0) {
    messageAttributes[SUBSCRIPTION_ID_ATTRIBUTE] = {
      DataType: "String",
      StringValue: subscriptionId,
    };
  }

  await getSqsClient().send(
    new SendMessageCommand({
      QueueUrl: deadLetterQueueUrl(),
      MessageBody: record.body,
      MessageAttributes: messageAttributes,
    }),
  );
}

// ---------------------------------------------------------------------------
// High-level routing
// ---------------------------------------------------------------------------

/**
 * Route a single SQS record to a customer, classifying the outcome
 * (Requirement 4.1, 15.6).
 *
 * - Returns `{ status: "routed", event }` when the subscription resolves to a
 *   customer; the caller proceeds to process `event`.
 * - Returns `{ status: "dead-lettered", reason }` when the record is a
 *   permanent failure (malformed message or unknown subscription); the record
 *   has already been sent to the DLQ and the caller should delete it from the
 *   main queue.
 * - Throws on a transient failure (Data API unavailable, missing config) so the
 *   caller lets the SQS message return to the queue and retry.
 */
export async function routeRecord(record: SQSRecord): Promise<RouteOutcome> {
  let parsed: ParsedRecord;
  try {
    parsed = parseRecord(record);
  } catch (error) {
    if (error instanceof MalformedMessageError) {
      console.error("Dead-lettering malformed SQS record", {
        messageId: record.messageId,
        reason: error.message,
      });
      await sendToDeadLetterQueue(record, error.message);
      return { status: "dead-lettered", reason: error.message };
    }
    throw error;
  }

  const { subscriptionId, event } = parsed;

  let customerId: string;
  try {
    customerId = await resolveCustomerId(subscriptionId);
  } catch (error) {
    if (error instanceof SubscriptionNotFoundError) {
      // Missing subscription-to-customer mapping — permanent (Requirement 15.6).
      console.error("Dead-lettering event with unresolved subscription", {
        messageId: record.messageId,
        subscriptionId,
        eventId: event.eventId,
      });
      await sendToDeadLetterQueue(record, error.message);
      return { status: "dead-lettered", reason: error.message };
    }
    // Transient failure — rethrow so SQS retries the message.
    throw error;
  }

  return {
    status: "routed",
    event: {
      subscriptionId,
      customerId,
      eventType: event.name,
      event,
    },
  };
}
