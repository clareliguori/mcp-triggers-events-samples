/**
 * MCP Server 2 (Message Scheduler) Lambda handler — migrated to the SDK's
 * McpServer for protocol handling (events/list, events/subscribe,
 * events/unsubscribe) while retaining the existing subscription store and
 * webhook delivery path.
 *
 * Dual-triggered:
 * 1. EventBridge (every 1 min) — schedule check: load subscriptions, evaluate
 *    cron, deliver briefing.trigger to due customers.
 * 2. API Gateway — MCP protocol (via SDK McpServer) + manual trigger REST route.
 */

import { randomUUID } from "node:crypto";

import type {
  BriefingTriggerData,
  McpEventPayload,
  WebhookSubscription,
} from "@mcp-events/shared";
import { EVENT_NAME_BRIEFING_TRIGGER, uuidV4Schema } from "@mcp-events/shared";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { DeliveryOutcome } from "@mcp-events/mcp-server-core";
import {
  buildMcpEvent,
  createMcpLambdaHandler,
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
// Re-exports preserved for the existing test surface
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
// HTTP plumbing
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

// ---------------------------------------------------------------------------
// MCP Server (SDK) — protocol handling for events/list, subscribe, unsubscribe
// ---------------------------------------------------------------------------

const server = new McpServer(
  { name: "scheduler-briefing", version: "1.0.0" },
  {
    events: {
      serverless: true,
      webhook: {
        ttlMs: 30 * 60 * 1000,
        getPrincipal: (ctx) => ctx.http?.authInfo?.clientId ?? ctx.sessionId ?? "lambda",
      },
    },
  },
);

server.registerEvent("briefing.trigger", {
  description:
    "Emitted per customer schedule to trigger earthquake briefing generation",
  inputSchema: z.object({
    schedule: z.string().optional().describe("Cron expression for this customer's briefing schedule"),
  }),
  emitOnly: true,
});

/** SDK-based MCP protocol handler for API Gateway requests. */
const mcpHandler = createMcpLambdaHandler(server);

// ---------------------------------------------------------------------------
// Event type constant (preserved for tests)
// ---------------------------------------------------------------------------

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
// Subscription creation (existing store, used by subscription manager)
// ---------------------------------------------------------------------------

interface SubscribeInputs {
  event: WebhookSubscription["eventName"];
  callbackUrl: string;
  secret: string;
  schedule?: string;
  ttlSeconds: number;
  customerId?: string;
}

export async function createSubscription(
  inputs: SubscribeInputs,
  now: Date = new Date(),
) {
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
// Webhook delivery (existing path)
// ---------------------------------------------------------------------------

export function buildBriefingEvent(
  data: BriefingTriggerData,
  now: Date = new Date(),
): McpEventPayload<BriefingTriggerData> {
  return buildMcpEvent(
    EVENT_NAME_BRIEFING_TRIGGER,
    data,
    `${data.customerId}:${data.scheduledTime}`,
    now,
  );
}

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

export interface ScheduleCheckSummary {
  activeSubscriptions: number;
  due: number;
  delivered: number;
  failed: number;
}

export async function runScheduleCheck(
  now: Date = new Date(),
): Promise<ScheduleCheckSummary> {
  const subscriptions = await loadActiveSubscriptions(now.getTime());
  const due = dueSubscriptions(subscriptions, now);

  let delivered = 0;
  let failed = 0;
  for (const subscription of due) {
    if (!subscription.customerId) {
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
// Manual trigger (POST /trigger-briefing/{customerId})
// ---------------------------------------------------------------------------

export interface ManualTriggerResult {
  eventId: string;
  delivered: boolean;
}

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
// Manual trigger REST surface
// ---------------------------------------------------------------------------

function isTriggerBriefingRequest(event: APIGatewayProxyEvent): boolean {
  const route = event.resource || event.path || "";
  return route.includes("/trigger-briefing/");
}

function triggerCustomerId(event: APIGatewayProxyEvent): string | undefined {
  const fromParams = event.pathParameters?.customerId;
  if (fromParams) return fromParams;
  const match = /\/trigger-briefing\/([^/]+)/.exec(event.path ?? "");
  return match ? decodeURIComponent(match[1]) : undefined;
}

function extractReason(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null && "reason" in body) {
    const reason = (body as { reason?: unknown }).reason;
    if (typeof reason === "string") return reason;
  }
  return undefined;
}

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

function isApiGatewayEvent(event: unknown): event is APIGatewayProxyEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    "httpMethod" in event &&
    typeof (event as APIGatewayProxyEvent).httpMethod === "string"
  );
}

export const handler = async (
  event: unknown,
): Promise<APIGatewayProxyResult | void> => {
  if (isApiGatewayEvent(event)) {
    // Manual trigger route takes priority
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

    // MCP protocol (events/list, events/subscribe, events/unsubscribe)
    return mcpHandler(event);
  }

  // EventBridge scheduled tick — run the schedule check
  await runScheduleCheck();
};
