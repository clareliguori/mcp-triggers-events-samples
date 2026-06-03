/**
 * MCP Server 2 (Message Scheduler) Lambda handler — fully migrated to the
 * SDK's McpServer for protocol handling (events/subscribe, list, unsubscribe)
 * with our DynamoDBWebhookSubscriptionStore. Webhook delivery during the
 * schedule-check uses the store directly + SDK webhook signing for Lambda-safe
 * awaitable delivery.
 *
 * Dual-triggered:
 * 1. EventBridge (every 1 min) — schedule check: load subscriptions from the
 *    store, evaluate cron, deliver `briefing.trigger` to due customers.
 * 2. API Gateway — MCP protocol (via SDK McpServer) + manual trigger REST route.
 */

import { randomUUID } from "node:crypto";

import type { BriefingTriggerData } from "@mcp-events/shared";
import { EVENT_NAME_BRIEFING_TRIGGER, customerIdSchema } from "@mcp-events/shared";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import {
  DynamoDBWebhookSubscriptionStore,
  createMcpLambdaHandler,
  deliverWebhookToSubscription,
  readRawBody,
  tryParseJson,
} from "@mcp-events/mcp-server-core";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

import { cronMatchesAt } from "./scheduler.js";

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
// MCP Server (SDK) — module-level instance with subscription store
// ---------------------------------------------------------------------------

const subscriptionStore = new DynamoDBWebhookSubscriptionStore();

const server = new McpServer(
  { name: "scheduler-briefing", version: "1.0.0" },
  {
    events: {
      serverless: true,
      webhook: {
        ttlMs: 2 * 60 * 60 * 1000,
        subscriptionStore,
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
    customerId: z.string().optional().describe("Customer ID for routing"),
  }),
  emitOnly: true,
});

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
  const subscriptions = await subscriptionStore.listByEvent(EVENT_NAME_BRIEFING_TRIGGER);
  const nowMs = now.getTime();
  const active = subscriptions.filter((s) => s.expiresAt > nowMs);

  console.log("Schedule check", {
    totalSubscriptions: subscriptions.length,
    activeSubscriptions: active.length,
  });

  let due = 0;
  let delivered = 0;
  let failed = 0;

  for (const sub of active) {
    const schedule = (sub.params as { schedule?: string }).schedule;
    if (!schedule) continue;

    let matches: boolean;
    try {
      matches = cronMatchesAt(schedule, now);
    } catch {
      continue;
    }
    if (!matches) continue;

    due += 1;
    const customerId = (sub.params as { customerId?: string }).customerId;
    if (!customerId) {
      console.warn("Skipping due subscription with no customerId", {
        subscriptionId: sub.id,
      });
      continue;
    }

    const data: BriefingTriggerData = {
      triggerType: "scheduled",
      customerId,
      scheduledTime: now.toISOString(),
    };

    const ok = await deliverWebhookToSubscription(
      sub,
      EVENT_NAME_BRIEFING_TRIGGER,
      data as unknown as Record<string, unknown>,
      `${customerId}:${data.scheduledTime}`,
    );
    if (ok) {
      delivered += 1;
      console.log("Delivered briefing trigger", { customerId, subscriptionId: sub.id });
    } else {
      failed += 1;
      console.error("Failed to deliver briefing trigger", { customerId, subscriptionId: sub.id });
    }
  }

  if (due > 0) {
    console.log("Schedule check complete", { due, delivered, failed });
  }

  return { activeSubscriptions: active.length, due, delivered, failed };
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
  const subscriptions = await subscriptionStore.listByEvent(EVENT_NAME_BRIEFING_TRIGGER);
  const nowMs = now.getTime();
  const matching = subscriptions.filter(
    (s) =>
      s.expiresAt > nowMs &&
      (s.params as { customerId?: string }).customerId === customerId,
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

  let anyDelivered = false;
  const eventId = randomUUID();
  for (const sub of matching) {
    const ok = await deliverWebhookToSubscription(
      sub,
      EVENT_NAME_BRIEFING_TRIGGER,
      data as unknown as Record<string, unknown>,
      `${customerId}:${data.scheduledTime}`,
    );
    if (ok) anyDelivered = true;
  }

  return { eventId, delivered: anyDelivered };
}

// ---------------------------------------------------------------------------
// Manual trigger REST surface
// ---------------------------------------------------------------------------

function isTriggerBriefingRequest(event: APIGatewayProxyEvent): boolean {
  return (event.path || "").includes("/trigger-briefing/");
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

  const parsed = customerIdSchema.safeParse(triggerCustomerId(event));
  if (!parsed.success) {
    return {
      statusCode: 400,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: "customerId must be a valid UUID" }),
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
// Test emit endpoint (POST /emit-test-event)
// ---------------------------------------------------------------------------

function isEmitTestRequest(event: APIGatewayProxyEvent): boolean {
  return (event.path || "").includes("/emit-test-event");
}

async function handleEmitTest(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  if (event.httpMethod.toUpperCase() !== "POST") {
    return { statusCode: 405, headers: JSON_HEADERS, body: JSON.stringify({ error: "POST only" }) };
  }
  const body = JSON.parse(event.body ?? "{}") as {
    customerId?: string;
    reason?: string;
  };
  if (!body.customerId) {
    return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: "customerId required" }) };
  }

  // Deliver to all active briefing.trigger subscriptions for this customer.
  const subs = await subscriptionStore.listByEvent(EVENT_NAME_BRIEFING_TRIGGER);
  const nowMs = Date.now();
  const matching = subs.filter(
    (s) => s.expiresAt > nowMs && (s.params as { customerId?: string }).customerId === body.customerId,
  );

  let delivered = 0;
  for (const sub of matching) {
    const data: BriefingTriggerData = {
      triggerType: "manual",
      customerId: body.customerId,
      scheduledTime: new Date().toISOString(),
      ...(body.reason ? { reason: body.reason } : {}),
    };
    const ok = await deliverWebhookToSubscription(
      sub,
      EVENT_NAME_BRIEFING_TRIGGER,
      data as unknown as Record<string, unknown>,
      `${body.customerId}:${data.scheduledTime}`,
    );
    if (ok) delivered += 1;
  }

  return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ delivered: delivered > 0, count: delivered }) };
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
    // Test emit endpoint
    if (isEmitTestRequest(event)) {
      return handleEmitTest(event);
    }
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
