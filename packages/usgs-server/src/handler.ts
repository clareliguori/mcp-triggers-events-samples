/**
 * MCP Server 1 (USGS Earthquake Feed) Lambda handler — migrated to the SDK's
 * McpServer for protocol handling (events/list, events/subscribe,
 * events/unsubscribe) while retaining the existing poll cycle and webhook
 * delivery path.
 *
 * Dual-triggered:
 * 1. EventBridge (every 5 min) — poll USGS, detect new earthquakes, deliver
 *    to matching subscriptions.
 * 2. API Gateway — MCP protocol (via SDK McpServer).
 */

import type {
  EarthquakeDetectedData,
  McpEventPayload,
  WebhookSubscription,
} from "@mcp-events/shared";
import { EVENT_NAME_EARTHQUAKE_DETECTED } from "@mcp-events/shared";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { DeliveryOutcome } from "@mcp-events/mcp-server-core";
import {
  buildMcpEvent,
  createMcpLambdaHandler,
  deliverEvent,
  getFetchImpl,
  loadActiveSubscriptions,
} from "@mcp-events/mcp-server-core";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

import { computeDeliveries } from "./filter.js";
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
// MCP Server (SDK) — protocol handling
// ---------------------------------------------------------------------------

const server = new McpServer(
  { name: "usgs-earthquake-feed", version: "1.0.0" },
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

server.registerEvent("earthquake.detected", {
  description:
    "Emitted when a new earthquake is detected matching subscription filters",
  inputSchema: z.object({
    minMagnitude: z.number().optional().describe("Only deliver earthquakes >= this magnitude"),
    region: z.string().optional().describe("Geographic region filter"),
    maxDepthKm: z.number().optional().describe("Only deliver earthquakes shallower than this depth (km)"),
  }),
  emitOnly: true,
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
// Webhook delivery (existing path)
// ---------------------------------------------------------------------------

export function buildEarthquakeEvent(
  earthquake: EarthquakeDetectedData,
  now: Date = new Date(),
): McpEventPayload<EarthquakeDetectedData> {
  return buildMcpEvent(
    EVENT_NAME_EARTHQUAKE_DETECTED,
    earthquake,
    earthquake.earthquakeId,
    now,
  );
}

export async function deliverEarthquake(
  subscription: WebhookSubscription,
  earthquake: EarthquakeDetectedData,
  now: Date = new Date(),
): Promise<DeliveryOutcome> {
  const event = buildMcpEvent(
    EVENT_NAME_EARTHQUAKE_DETECTED,
    earthquake,
    earthquake.earthquakeId,
    now,
  );
  return deliverEvent(subscription, event, now);
}

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

  const subscriptions = await loadActiveSubscriptions(now.getTime());
  const deliveries = computeDeliveries(detection.newEarthquakes, subscriptions);

  let delivered = 0;
  let failed = 0;
  for (const { subscription, earthquake } of deliveries) {
    const outcome = await deliverEarthquake(subscription, earthquake, now);
    if (outcome.delivered) {
      delivered += 1;
    } else {
      failed += 1;
    }
  }

  await commitCursor({
    previous: detection.cursor,
    newlySeenIds: detection.newEarthquakes.map((q) => q.earthquakeId),
    pollAt: now.toISOString(),
  });

  return {
    newEarthquakes: detection.newEarthquakes.length,
    deliveries: deliveries.length,
    delivered,
    failed,
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
    return mcpHandler(event);
  }

  // EventBridge scheduled tick — run the poll cycle
  await runPollCycle();
};
