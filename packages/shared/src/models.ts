/**
 * Shared data model interfaces for the MCP Events Serverless Agent.
 *
 * These types describe the shapes persisted to DynamoDB / S3, the MCP event
 * payloads exchanged over webhooks, and the request/response shapes for the
 * MCP `events/subscribe` protocol.
 *
 * Validation logic for these models lives in `validation.ts`. Constants used
 * by the validators (region list, magnitude bounds, etc.) live in
 * `constants.ts`.
 *
 * See the `Data Models` section of design.md for the canonical description
 * of each model.
 */

import type { TypedEventOccurrence } from "@modelcontextprotocol/server";

import type { Region } from "./constants.js";

// ---------------------------------------------------------------------------
// Customer configuration
// ---------------------------------------------------------------------------

/**
 * Stored in DynamoDB. Defines a customer's subscription parameters,
 * briefing preferences, and schedule. Each customer gets independent
 * subscriptions to both MCP servers.
 *
 * `customerId` equals the Cognito User Pool `sub` claim (UUID v4).
 */
export interface CustomerConfig {
  /** Primary key. Cognito user `sub` (UUID v4). */
  customerId: string;
  /** Human-readable name set by the user in the webapp. */
  displayName: string;
  /** Per-customer earthquake feed filter parameters. */
  subscriptionParams: SubscriptionParams;
  /** Custom system prompt used when generating briefing reports. */
  briefingPrompt: string;
  /** Cron expression for this customer's briefing trigger schedule. */
  briefingSchedule: number;
  /** Whether this customer's subscriptions are active. */
  active: boolean;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  updatedAt: string;
}

/**
 * Per-customer filter parameters for the USGS earthquake feed.
 * Also supplied to the MCP `events/subscribe` `inputSchema`.
 */
export interface SubscriptionParams {
  /** Only deliver earthquakes >= this magnitude. */
  minMagnitude?: number;
  /** Geographic region filter. */
  region?: Region;
  /** Only deliver earthquakes shallower than this depth (km). */
  maxDepthKm?: number;
}

// ---------------------------------------------------------------------------
// MCP event payloads
// ---------------------------------------------------------------------------

/**
 * Event payload delivered via webhook by both MCP servers.
 * Extends the SDK's TypedEventOccurrence with app-specific constraints:
 * narrowed event name union and required (non-nullable) cursor.
 */
export interface McpEventPayload<
  TData extends EarthquakeDetectedData | BriefingTriggerData =
    | EarthquakeDetectedData
    | BriefingTriggerData,
> extends TypedEventOccurrence<TData> {
  /** Narrowed to this app's event types. */
  name: "earthquake.detected" | "briefing.trigger";
  /** Always provided in this app (earthquake ID or customer:scheduledTime). */
  cursor: string;
}

/**
 * Event data payload for `earthquake.detected` events.
 * Derived from USGS GeoJSON feature properties.
 */
export interface EarthquakeDetectedData {
  /** USGS earthquake ID (e.g., "us7000n123"). */
  earthquakeId: string;
  /** Richter magnitude. */
  magnitude: number;
  /** Human-readable location (e.g., "10km SW of Ridgecrest, CA"). */
  place: string;
  coordinates: {
    /** Decimal degrees. */
    longitude: number;
    /** Decimal degrees. */
    latitude: number;
    /** Kilometers below surface. */
    depth: number;
  };
  /** ISO 8601 timestamp of earthquake occurrence. */
  time: string;
  /** Whether a tsunami warning was issued. */
  tsunami: boolean;
  /** Number of "felt" reports, if any. */
  felt: number | null;
  /** PAGER alert level. */
  alert: "green" | "yellow" | "orange" | "red" | null;
  /** USGS event page URL. */
  url: string;
}

/**
 * Event data payload for `briefing.trigger` events.
 */
export interface BriefingTriggerData {
  /** How the trigger was initiated. */
  triggerType: "scheduled" | "manual";
  /** Which customer this trigger is for. */
  customerId: string;
  /** Optional reason (typically only set for manual triggers). */
  reason?: string;
  /** ISO 8601 — when this trigger was scheduled for. */
  scheduledTime: string;
}

// ---------------------------------------------------------------------------
// Locking & subscriptions
// ---------------------------------------------------------------------------

/**
 * Stored in DynamoDB lock table. Implements distributed pessimistic locking
 * to prevent concurrent writes to a customer's session data.
 */
export interface CustomerSessionLock {
  /** Primary key: `lock#{customerId}`. */
  lockKey: string;
  /** Lambda request ID — unique per invocation. Used for safe release. */
  ownerId: string;
  /** ISO 8601. */
  acquiredAt: string;
  /** DynamoDB TTL (epoch seconds). Auto-cleanup for crashed holders. */
  expiresAt: number;
  /** Lock duration in seconds. */
  ttlSeconds: number;
}

/**
 * Stored in DynamoDB. Represents an active webhook subscription.
 * Each customer has one subscription per MCP server.
 */
export interface WebhookSubscription {
  /** Primary key (UUID v4). */
  subscriptionId: string;
  /** GSI: which customer owns this subscription. */
  customerId: string;
  /** Which MCP server this subscription is on. */
  serverEndpoint: string;
  /** Event type subscribed to. */
  eventName: "earthquake.detected" | "briefing.trigger";
  /** Webhook delivery URL. */
  callbackUrl: string;
  /**
   * The per-subscription Standard Webhooks signing secret, client-side
   * encrypted with this table's customer-managed KMS key and base64-encoded.
   *
   * The plaintext is a `whsec_` value (literal prefix `whsec_` followed by
   * base64 of 24-64 random bytes) generated by the Subscription Manager and
   * supplied to the MCP server in `delivery.secret`. It is encrypted with
   * `kms:Encrypt` (bound to `subscriptionId` via a KMS encryption context)
   * BEFORE being written here, so DynamoDB only ever holds ciphertext. Holders
   * decrypt it in memory with `kms:Decrypt` to sign (MCP servers) or verify
   * (Webhook Receiver) deliveries. See `crypto.ts` for the helpers.
   */
  encryptedSecret: string;
  /** Customer-specific filter params (set for MCP Server 1). */
  filterParams?: SubscriptionParams;
  /** Customer's cron schedule (set for MCP Server 2). */
  schedule?: number;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601 TTL. */
  expiresAt: string;
  /** ISO 8601. */
  lastRefreshedAt: string;
  status: "active" | "expired" | "failed";
}

// ---------------------------------------------------------------------------
// Agent session state & briefing reports
// ---------------------------------------------------------------------------

/**
 * Persisted to S3 by the Strands SDK SessionManager.
 * Each customer has their own session at `sessions/{customerId}/scopes/agent/agent/snapshots/snapshot_latest.json`.
 *
 * The SDK handles serialization; this type describes the logical structure
 * exposed to application code. The conversation history IS the accumulated
 * earthquake data — there is no separate accumulator array.
 */
export interface AgentSessionState {
  /** Equals `customerId`. Ensures per-customer isolation. */
  sessionId: string;
  /** Redundant but explicit for clarity. */
  customerId: string;
  /** Full conversation history — also serves as the earthquake accumulator. */
  messages: ConversationMessage[];
  metadata: AgentSessionMetadata;
}

export interface AgentSessionMetadata {
  /** Last processed event ID — used for idempotency checks. */
  lastEventId: string;
  /** ISO 8601. */
  lastActiveAt: string;
  invocationCount: number;
  /** ISO 8601 — when last briefing was generated, or null if none yet. */
  lastBriefingAt: string | null;
  /** Cached from {@link CustomerConfig.displayName}. */
  customerDisplayName: string;
}

export interface ConversationMessage {
  role: "user" | "assistant" | "tool";
  content: string | ToolUseContent[];
  /** ISO 8601. */
  timestamp: string;
}

/**
 * Tool-use content block within a conversation message. Mirrors the MCP /
 * Strands SDK shape; values are passed through opaquely by application
 * code so stricter typing lives in the SDK.
 */
export interface ToolUseContent {
  type: "tool_use" | "tool_result";
  toolName?: string;
  toolUseId?: string;
  input?: unknown;
  output?: unknown;
}

/**
 * Output artifact written to S3 when a briefing is generated.
 * Stored at `reports/{customerId}/{reportId}.json`.
 */
export interface BriefingReport {
  /** UUID v4. */
  reportId: string;
  /** Which customer this report belongs to. */
  customerId: string;
  /** Cached from {@link CustomerConfig.displayName}. */
  customerDisplayName: string;
  /** The briefing prompt used to generate this report. */
  briefingPrompt: string;
  /** ISO 8601. */
  generatedAt: string;
  /** ISO 8601 — start of reporting period. */
  periodStart: string;
  /** ISO 8601 — end of reporting period. */
  periodEnd: string;
  /** High-level summary of seismic activity. */
  summary: string;
  totalEarthquakes: number;
  /** Significant earthquakes highlighted by the LLM. */
  notableQuakes: NotableQuake[];
  /** Analysis of geographic clustering. */
  geographicPatterns: string;
  /** How this period compares to the last. */
  comparisonToPrevious: string;
}

export interface NotableQuake {
  earthquakeId: string;
  magnitude: number;
  place: string;
  /** Why this earthquake is notable. */
  reason: string;
}

/**
 * Lightweight report list item returned by the Data API list endpoint.
 * Does not include the full report body.
 */
export interface ReportSummary {
  reportId: string;
  /** ISO 8601. */
  generatedAt: string;
  /** ISO 8601. */
  periodStart: string;
  /** ISO 8601. */
  periodEnd: string;
  totalEarthquakes: number;
  /** First 200 characters of the full summary. */
  summary: string;
}

// ---------------------------------------------------------------------------
// MCP `events/subscribe` request / response
// ---------------------------------------------------------------------------

/**
 * MCP `events/subscribe` request parameters.
 * Includes per-customer filter params via `inputSchema`.
 */
export interface SubscribeParams {
  /** Event type name. */
  event: "earthquake.detected" | "briefing.trigger";
  delivery: {
    mode: "webhook";
    /** Callback URL for delivery. */
    url: string;
    /**
     * REQUIRED client-supplied per-subscription Standard Webhooks signing
     * secret in `whsec_` format. Generated by the Subscription Manager (the MCP
     * client); the MCP server never generates it.
     */
    secret: string;
  };
  /** Per-customer filter / schedule parameters. */
  inputSchema?: SubscribeInputSchema;
  /** Subscription TTL in seconds. */
  ttl?: number;
}

export interface SubscribeInputSchema {
  /** For `earthquake.detected` subscriptions. */
  minMagnitude?: number;
  /** For `earthquake.detected` subscriptions. */
  region?: Region;
  /** For `earthquake.detected` subscriptions. */
  maxDepthKm?: number;
  /** For `briefing.trigger` subscriptions (interval in hours). */
  intervalHours?: number;
}

// ---------------------------------------------------------------------------
// USGS cursor state
// ---------------------------------------------------------------------------

/**
 * Stored in DynamoDB by MCP Server 1. Tracks which earthquakes have already
 * been emitted as events. Shared across customers; per-subscription
 * filtering happens at delivery time.
 */
export interface UsgsCursorState {
  /** Primary key (fixed value, e.g., "usgs-2.5-day"). */
  cursorId: string;
  /** Set of earthquake IDs from recent polls (rolling window). */
  lastSeenIds: string[];
  /** ISO 8601. */
  lastPollAt: string;
  /** ISO 8601 — when last event was emitted. */
  lastEmittedAt: string;
  /** Running count of emitted events. */
  totalEmitted: number;
}
