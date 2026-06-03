/**
 * MCP Server 1 (USGS Earthquake Feed) Lambda handler — fully migrated to the
 * SDK's McpServer for protocol handling (events/subscribe, list, unsubscribe)
 * with our DynamoDBWebhookSubscriptionStore. Webhook delivery during the poll
 * cycle uses the store directly + SDK's webhook signing for Lambda-safe awaitable
 * delivery.
 *
 * Dual-triggered:
 * 1. EventBridge (every 5 min) — poll USGS, detect new earthquakes, deliver
 *    matching events as signed webhooks to subscriptions from the store.
 * 2. API Gateway — MCP protocol (via SDK McpServer transport).
 */

import type { EarthquakeDetectedData, SubscriptionParams } from "@mcp-events/shared";
import { EVENT_NAME_EARTHQUAKE_DETECTED } from "@mcp-events/shared";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import {
  DynamoDBWebhookSubscriptionStore,
  createMcpLambdaHandler,
  deliverWebhookToSubscription,
  getFetchImpl,
} from "@mcp-events/mcp-server-core";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

import { matchesFilter } from "./filter.js";
import {
  type FetchLike as PollerFetchLike,
  commitCursor,
  detectNewEarthquakes,
} from "./poller.js";

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
// MCP Server (SDK) — module-level instance with subscription store
// ---------------------------------------------------------------------------

const subscriptionStore = new DynamoDBWebhookSubscriptionStore();

const server = new McpServer(
  { name: "usgs-earthquake-feed", version: "1.0.0" },
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

server.registerEvent("earthquake.detected", {
  description:
    "Emitted when a new earthquake is detected matching subscription filters",
  inputSchema: z.object({
    minMagnitude: z.number().optional().describe("Only deliver earthquakes >= this magnitude"),
    region: z.string().optional().describe("Geographic region filter"),
    maxDepthKm: z.number().optional().describe("Only deliver earthquakes shallower than this depth (km)"),
    customerId: z.string().optional().describe("Customer ID for routing"),
  }),
  emitOnly: true,
  matches: (params, data) => {
    return matchesFilter(data as unknown as EarthquakeDetectedData, params as SubscriptionParams);
  },
});

const mcpHandler = createMcpLambdaHandler(server);

// ---------------------------------------------------------------------------
// Event type constant (preserved for tests)
// ---------------------------------------------------------------------------

export const EARTHQUAKE_EVENT_TYPE = {
  name: EVENT_NAME_EARTHQUAKE_DETECTED,
  description:
    "Emitted when a new earthquake is detected matching subscription filters",
  inputSchema: {
    type: "object",
    properties: {
      minMagnitude: {
        type: "number",
        description: "Only deliver earthquakes >= this magnitude",
      },
      region: {
        type: "string",
        description:
          "Geographic region filter (pacific, americas, europe, asia, africa)",
      },
      maxDepthKm: {
        type: "number",
        description: "Only deliver earthquakes shallower than this depth (km)",
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Poll cycle orchestration (EventBridge trigger)
// ---------------------------------------------------------------------------

export interface PollSummary {
  newEarthquakes: number;
  deliveries: number;
  delivered: number;
  failed: number;
}

export async function runPollCycle(
  now: Date = new Date(),
): Promise<PollSummary> {
  const detection = await detectNewEarthquakes({
    fetchImpl: getFetchImpl() as unknown as PollerFetchLike,
  });

  const subscriptions = await subscriptionStore.listByEvent(EVENT_NAME_EARTHQUAKE_DETECTED);
  const nowMs = now.getTime();
  const active = subscriptions.filter((s) => s.expiresAt > nowMs);

  console.log("Poll cycle", {
    newEarthquakes: detection.newEarthquakes.length,
    totalSubscriptions: subscriptions.length,
    activeSubscriptions: active.length,
  });

  let deliveries = 0;
  let delivered = 0;
  let failed = 0;

  for (const earthquake of detection.newEarthquakes) {
    for (const sub of active) {
      if (!matchesFilter(earthquake, sub.params as SubscriptionParams)) continue;
      deliveries += 1;
      const ok = await deliverWebhookToSubscription(
        sub,
        EVENT_NAME_EARTHQUAKE_DETECTED,
        earthquake as unknown as Record<string, unknown>,
        earthquake.earthquakeId,
      );
      if (ok) {
        delivered += 1;
        console.log("Delivered earthquake", { earthquakeId: earthquake.earthquakeId, subscriptionId: sub.id });
      } else {
        failed += 1;
        console.error("Failed to deliver earthquake", { earthquakeId: earthquake.earthquakeId, subscriptionId: sub.id });
      }
    }
  }

  if (detection.newEarthquakes.length > 0) {
    console.log("Poll cycle complete", { deliveries, delivered, failed });
  }

  await commitCursor({
    previous: detection.cursor,
    newlySeenIds: detection.newEarthquakes.map((q) => q.earthquakeId),
    pollAt: now.toISOString(),
  });

  return { newEarthquakes: detection.newEarthquakes.length, deliveries, delivered, failed };
}

// ---------------------------------------------------------------------------
// Test emit endpoint (POST /emit-test-event)
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

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
    earthquake?: Record<string, unknown>;
  };
  if (!body.earthquake) {
    return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: "earthquake required" }) };
  }

  // Deliver to all active subscriptions for this event type.
  const subs = await subscriptionStore.listByEvent(EVENT_NAME_EARTHQUAKE_DETECTED);
  const nowMs = Date.now();
  const active = subs.filter((s) => s.expiresAt > nowMs);

  let delivered = 0;
  for (const sub of active) {
    if (!matchesFilter(body.earthquake as unknown as EarthquakeDetectedData, sub.params as SubscriptionParams)) continue;
    const ok = await deliverWebhookToSubscription(
      sub,
      EVENT_NAME_EARTHQUAKE_DETECTED,
      body.earthquake,
      (body.earthquake.earthquakeId as string) ?? "test-event",
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
    if (isEmitTestRequest(event)) {
      return handleEmitTest(event);
    }
    return mcpHandler(event);
  }

  // EventBridge scheduled tick — run the poll cycle
  await runPollCycle();
};
