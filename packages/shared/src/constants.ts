/**
 * Shared constants used across the MCP Events Serverless Agent monorepo.
 *
 * These values are referenced by Data API validators, MCP servers, the agent,
 * the subscription manager, and the webapp. Centralizing them here keeps the
 * domain rules in one place and ensures the validation schemas, runtime
 * checks, and CDK configuration agree on the same values.
 */

/**
 * Allowed values for {@link CustomerConfig.subscriptionParams.region}.
 *
 * Validates Requirement 16.3.
 */
export const REGIONS = [
  "pacific",
  "americas",
  "europe",
  "asia",
  "africa",
] as const;

/** Type for valid region values. */
export type Region = (typeof REGIONS)[number];

/**
 * Inclusive bounds for {@link CustomerConfig.subscriptionParams.minMagnitude}.
 *
 * Validates Requirement 16.2.
 */
export const MIN_MAGNITUDE = 0;
export const MAX_MAGNITUDE = 10;

/** Default minimum magnitude when a customer does not specify one. */
export const DEFAULT_MIN_MAGNITUDE = 2.5;

/**
 * Allowed length range for {@link CustomerConfig.briefingPrompt}.
 *
 * Validates Requirement 16.4.
 */
export const BRIEFING_PROMPT_MIN_LENGTH = 1;
export const BRIEFING_PROMPT_MAX_LENGTH = 2000;

/**
 * UUID v4 format. Used for internally-generated identifiers (eventId,
 * subscriptionId, reportId) which are created with `crypto.randomUUID()` and
 * are therefore always v4.
 *
 * Validates Requirement 16.1.
 */
export const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * General UUID format (any version 1-8, RFC 4122 variant). Used for
 * `customerId`, which equals the Cognito User Pool `sub` claim. Cognito subs
 * are UUIDs but are NOT guaranteed to be version 4 (observed subs use other
 * version nibbles), so customerId must be validated against this looser regex
 * rather than {@link UUID_V4_REGEX}, which would reject legitimate users.
 *
 * Validates Requirement 16.1.
 */
export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Allowed briefing schedule options. Each entry maps an interval (in hours)
 * to a human-readable label. The scheduler server fires a briefing trigger
 * when `now - lastDeliveredAt >= intervalHours` for a subscription.
 */
export const BRIEFING_SCHEDULES = [
  { intervalHours: 4, label: "Every 4 hours" },
  { intervalHours: 8, label: "Every 8 hours" },
  { intervalHours: 12, label: "Every 12 hours" },
  { intervalHours: 24, label: "Every 24 hours" },
] as const;

/** The allowed interval values extracted for validation. */
export const BRIEFING_SCHEDULE_INTERVALS = BRIEFING_SCHEDULES.map(
  (s) => s.intervalHours,
) as unknown as [number, ...number[]];

/**
 * Default TTL (in seconds) for an MCP `events/subscribe` subscription.
 * Subscription Manager refreshes subscriptions before this elapses.
 */
export const DEFAULT_SUBSCRIPTION_TTL_SECONDS = 7200; // 2 hours

/**
 * Threshold (in seconds) before {@link DEFAULT_SUBSCRIPTION_TTL_SECONDS}
 * elapses at which the Subscription Manager refreshes subscriptions.
 */
export const SUBSCRIPTION_REFRESH_THRESHOLD_SECONDS = 600; // 10 minutes

/**
 * Default TTL (in seconds) for the per-customer session lock held by the
 * Serverless Agent in DynamoDB. The lock auto-expires if the holder crashes.
 */
export const DEFAULT_LOCK_TTL_SECONDS = 120;

/**
 * Maximum time (in milliseconds) the Serverless Agent will wait to acquire
 * the per-customer session lock before throwing and returning the SQS
 * message to the queue for retry.
 */
export const LOCK_ACQUISITION_TIMEOUT_MS = 240_000;

/**
 * Tolerance window (in seconds) for Standard Webhooks signature timestamp
 * verification. Deliveries with a timestamp older or newer than this
 * window are rejected as potential replay attacks.
 */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300; // 5 minutes

/**
 * Maximum number of recent earthquake IDs the USGS cursor retains as a
 * rolling window for deduplication.
 */
export const USGS_CURSOR_MAX_IDS = 200;

/**
 * MCP event type names emitted by the two MCP servers.
 */
export const EVENT_NAME_EARTHQUAKE_DETECTED = "earthquake.detected";
export const EVENT_NAME_BRIEFING_TRIGGER = "briefing.trigger";

/**
 * Standard Webhooks symmetric secret format used for per-subscription webhook
 * signing (MCP Events extension webhook delivery mode). The secret is the
 * literal prefix `whsec_` followed by the base64 encoding of 24 to 64 random
 * bytes. The Subscription Manager (MCP client) generates one per subscription
 * and supplies it in `delivery.secret`; the MCP server never generates it.
 *
 * This regex validates the structural shape (prefix + base64 charset). The
 * decoded-length bound (24-64 bytes) is enforced separately by the validator
 * since it cannot be expressed in a regex.
 *
 * Validates Requirement 16.6.
 */
export const WHSEC_SECRET_PREFIX = "whsec_";
export const WHSEC_SECRET_REGEX = /^whsec_[A-Za-z0-9+/]+={0,2}$/;
export const WHSEC_SECRET_MIN_BYTES = 24;
export const WHSEC_SECRET_MAX_BYTES = 64;
