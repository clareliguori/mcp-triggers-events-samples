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
 * the shared machinery (MCP transport, subscription lifecycle, webhook
 * signing/delivery, client seams, dual-trigger dispatch) lives in
 * `@mcp-events/mcp-server-core`. The differences are intentional and limited to
 * this server's domain:
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
 * Testability: orchestration is factored into small helpers and every
 * side-effecting dependency (the DynamoDB document client, the KMS client,
 * `fetch`, and `sleep`) is injectable through a `setXForTesting` seam
 * (re-exported from the core package). Production code never calls the setters.
 */

import { randomUUID } from "node:crypto";

import type {
  BriefingTriggerData,
  McpEventPayload,
  SubscribeResult,
  WebhookSubscription,
} from "@mcp-events/shared";
import { EVENT_NAME_BRIEFING_TRIGGER, uuidV4Schema } from "@mcp-events/shared";
import type { DeliveryOutcome } from "@mcp-events/mcp-server-core";
import {
  buildMcpEvent,
  createDualTriggerHandler,
  createMcpRequestHandler,
  createSubscription as createCoreSubscription,
  deliverEvent,
  loadActiveSubscriptions,
  readRawBody,
  serverEndpoint,
  tryParseJson,
} from "@mcp-events/mcp-server-core";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

import { dueSubscriptions } from "./scheduler.js";

// ---------------------------------------------------------------------------
// Re-exports preserved for the existing test (and CDK) surface
// ---------------------------------------------------------------------------

export {
  MCP_SUBSCRIPTION_ID_HEADER,
  WEBHOOK_RETRY_DELAYS_MS,
  loadActiveSubscriptions,
  setDocumentClientForTesting,
  setFetchForTesting,
  setKmsClientForTesting,
  setSleepForTesting,
} from "@mcp-events/mcp-server-core";
export type { DeliveryOutcome, FetchLike } from "@mcp-events/mcp-server-core";

// ---------------------------------------------------------------------------
// HTTP plumbing shared by both API Gateway surfaces
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

// ---------------------------------------------------------------------------
// Event type (domain)
// ---------------------------------------------------------------------------

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
// Subscription creation (domain wrapper over the shared create)
// ---------------------------------------------------------------------------

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
 * Create a subscription on `events/subscribe` (Requirements 14.3, 14.5, 17.5).
 * A thin domain wrapper over the shared {@link createCoreSubscription}: it maps
 * MCP Server 2's cron `schedule` into the generic `domainAttributes` (only when
 * supplied) and records this server's endpoint. The shared helper mints the
 * `subscriptionId`, KMS-encrypts the client-supplied secret bound to that id,
 * persists the active record, and returns the {@link SubscribeResult}.
 */
export async function createSubscription(
  inputs: SubscribeInputs,
  now: Date = new Date(),
): Promise<SubscribeResult> {
  return createCoreSubscription(
    {
      event: inputs.event,
      callbackUrl: inputs.callbackUrl,
      secret: inputs.secret,
      ttlSeconds: inputs.ttlSeconds,
      customerId: inputs.customerId,
      serverEndpoint: serverEndpoint("https://scheduler-mcp.earthquake-agent"),
      domainAttributes:
        inputs.schedule !== undefined ? { schedule: inputs.schedule } : {},
    },
    now,
  );
}

// ---------------------------------------------------------------------------
// Webhook delivery (domain event construction + delivery)
// ---------------------------------------------------------------------------

/** Build the `briefing.trigger` MCP event payload for one customer. */
export function buildBriefingEvent(
  data: BriefingTriggerData,
  now: Date = new Date(),
): McpEventPayload<BriefingTriggerData> {
  // Opaque ordering/resumption cursor; (customer, scheduled minute) is stable.
  return buildMcpEvent(
    EVENT_NAME_BRIEFING_TRIGGER,
    data,
    `${data.customerId}:${data.scheduledTime}`,
    now,
  );
}

/**
 * Deliver one `briefing.trigger` to one subscription as a signed webhook
 * (Requirements 2.2, 14.4, 14.5), retrying with exponential backoff on failure.
 * Builds the domain event, then delegates the decrypt/serialize/sign/POST/retry
 * sequence to the shared {@link deliverEvent}; the returned
 * {@link DeliveryOutcome} carries the delivered event's `eventId`.
 */
export async function deliverBriefing(
  subscription: WebhookSubscription,
  data: BriefingTriggerData,
  now: Date = new Date(),
): Promise<DeliveryOutcome> {
  const event = buildMcpEvent(
    EVENT_NAME_BRIEFING_TRIGGER,
    data,
    `${data.customerId}:${data.scheduledTime}`,
    now,
  );
  return deliverEvent(subscription, event, now);
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

/**
 * The MCP HTTP transport for MCP Server 2: declares `briefing.trigger` and maps
 * a subscribe `inputSchema` to the cron `schedule` domain attribute (only when
 * supplied).
 */
const mcpHandler = createMcpRequestHandler({
  eventType: BRIEFING_EVENT_TYPE,
  eventName: EVENT_NAME_BRIEFING_TRIGGER,
  serverEndpoint: serverEndpoint("https://scheduler-mcp.earthquake-agent"),
  serverName: "scheduler-briefing",
  mapInputSchema: (inputSchema) =>
    inputSchema?.schedule !== undefined
      ? { schedule: inputSchema.schedule }
      : {},
});

/**
 * Dual-trigger Lambda entry point. An API Gateway proxy event is served either
 * as the manual trigger REST route or as the MCP HTTP transport; anything else
 * (the EventBridge scheduled tick) runs a schedule check. The schedule-check
 * path returns no HTTP result.
 */
export const handler = createDualTriggerHandler({
  mcpHandler,
  onSchedule: async () => {
    await runScheduleCheck();
  },
  routes: [
    {
      match: isTriggerBriefingRequest,
      handle: handleManualTrigger,
      onError: (error) => {
        console.error("Unhandled manual trigger error", error);
        return {
          statusCode: 500,
          headers: JSON_HEADERS,
          body: JSON.stringify({ error: "Internal Server Error" }),
        };
      },
    },
  ],
});
