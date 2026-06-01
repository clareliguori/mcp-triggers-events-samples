/**
 * MCP Server 1 (USGS Earthquake Feed) Lambda handler (task 6.5).
 *
 * This single Lambda is **dual-triggered** and serves the two halves of MCP
 * Server 1 (design Component 1):
 *
 * 1. **EventBridge scheduled trigger (every 5 min) — the poll cycle.** It
 *    detects new earthquakes via the cursor (poller.ts, task 6.1), computes the
 *    per-subscription deliveries (filter.ts, task 6.3), delivers each matching
 *    earthquake to its subscription's webhook callback as an
 *    `earthquake.detected` MCP event, and only then commits the cursor so a poll
 *    that fails before emitting leaves the cursor unchanged and retries next
 *    cycle (Requirements 1.1-1.4, 1.6, 15.4).
 * 2. **API Gateway proxy trigger — the MCP HTTP transport.** It answers the MCP
 *    Events protocol methods `events/list`, `events/subscribe`, and
 *    `events/unsubscribe` as JSON-RPC 2.0 over `POST /mcp` (Requirements 14.1,
 *    14.3).
 *
 * The MCP transport, subscription lifecycle, webhook signing/delivery, the
 * side-effecting client singletons + test seams, and the dual-trigger dispatch
 * are all shared with MCP Server 2 and live in `@mcp-events/mcp-server-core`.
 * This module keeps only MCP Server 1's domain: the `earthquake.detected` event
 * type, the USGS poll cycle, and the earthquake-specific event construction.
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
 * Testability: the poll/delivery orchestration is factored into small helpers
 * and every side-effecting dependency (the DynamoDB document client, the KMS
 * client, `fetch`, and `sleep`) is injectable through a `setXForTesting` seam
 * (re-exported from the core package). Production code never calls the setters.
 */

import type {
  EarthquakeDetectedData,
  McpEventPayload,
  SubscriptionParams,
  WebhookSubscription,
} from "@mcp-events/shared";
import { EVENT_NAME_EARTHQUAKE_DETECTED } from "@mcp-events/shared";
import type { DeliveryOutcome } from "@mcp-events/mcp-server-core";
import {
  buildMcpEvent,
  createDualTriggerHandler,
  createMcpRequestHandler,
  deliverEvent,
  getFetchImpl,
  loadActiveSubscriptions,
  serverEndpoint,
} from "@mcp-events/mcp-server-core";

import { computeDeliveries } from "./filter.js";
import {
  type FetchLike as PollerFetchLike,
  commitCursor,
  detectNewEarthquakes,
} from "./poller.js";

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
// Event type (domain)
// ---------------------------------------------------------------------------

/**
 * The `earthquake.detected` event type this server declares via `events/list`
 * (Requirement 14.1). The `inputSchema` advertises the per-subscription filter
 * parameters a client may supply in `events/subscribe.inputSchema`.
 */
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
// Webhook delivery (domain event construction + delivery)
// ---------------------------------------------------------------------------

/** Build the `earthquake.detected` MCP event payload for one earthquake. */
export function buildEarthquakeEvent(
  earthquake: EarthquakeDetectedData,
  now: Date = new Date(),
): McpEventPayload<EarthquakeDetectedData> {
  // Opaque ordering/resumption cursor; the earthquake id is stable + unique.
  return buildMcpEvent(
    EVENT_NAME_EARTHQUAKE_DETECTED,
    earthquake,
    earthquake.earthquakeId,
    now,
  );
}

/**
 * Deliver one earthquake to one subscription as a signed `earthquake.detected`
 * webhook (Requirements 1.3, 14.4, 14.5), retrying with exponential backoff on
 * failure (Requirement 15.1). Builds the domain event, then delegates the
 * decrypt/serialize/sign/POST/retry sequence to the shared
 * {@link deliverEvent}, which fixes the timestamp/eventId/cursor up front so
 * every retry sends byte-identical, still-in-tolerance content.
 */
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

/** Summary of a single poll cycle, returned for logging / tests. */
export interface PollSummary {
  newEarthquakes: number;
  deliveries: number;
  delivered: number;
  failed: number;
}

/**
 * Run one poll cycle (Requirements 1.1-1.4, 1.6, 15.4):
 * detect new earthquakes -> load active subscriptions -> compute the matching
 * (earthquake, subscription) deliveries -> deliver each via signed webhook ->
 * commit the cursor.
 *
 * The cursor is committed ONLY after the emission step completes. If detection
 * throws (for example USGS is unavailable), the function propagates the error
 * before reaching {@link commitCursor}, so the cursor stays unchanged and the
 * same earthquakes are retried next poll (Requirement 15.4). Individual webhook
 * failures, by contrast, do not block the cursor: deliveries are retried inline
 * and the Webhook Receiver / SQS provide at-least-once buffering downstream, so
 * the cursor still advances once per completed poll (matching the design's poll
 * sequence).
 */
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

  // Only reached when detection succeeded; advances the cursor exactly once per
  // poll after emission (Requirements 1.4, 15.4).
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

/**
 * The MCP HTTP transport for MCP Server 1: declares `earthquake.detected` and
 * maps a subscribe `inputSchema` to earthquake filter params, dropping any
 * unset dimension so an all-empty filter becomes "deliver everything".
 */
const mcpHandler = createMcpRequestHandler({
  eventType: EARTHQUAKE_EVENT_TYPE,
  eventName: EVENT_NAME_EARTHQUAKE_DETECTED,
  serverEndpoint: serverEndpoint("https://usgs-mcp.earthquake-agent"),
  serverName: "usgs-earthquake-feed",
  mapInputSchema: (inputSchema) => {
    const filter: SubscriptionParams = {};
    if (inputSchema?.minMagnitude !== undefined) {
      filter.minMagnitude = inputSchema.minMagnitude;
    }
    if (inputSchema?.region !== undefined) {
      filter.region = inputSchema.region;
    }
    if (inputSchema?.maxDepthKm !== undefined) {
      filter.maxDepthKm = inputSchema.maxDepthKm;
    }
    return Object.keys(filter).length > 0 ? { filterParams: filter } : {};
  },
});

/**
 * Dual-trigger Lambda entry point. An API Gateway proxy event is served as the
 * MCP HTTP transport; anything else (the EventBridge scheduled tick) runs a poll
 * cycle. The poll path returns no HTTP result.
 */
export const handler = createDualTriggerHandler({
  mcpHandler,
  onSchedule: async () => {
    await runPollCycle();
  },
  routes: [],
});
