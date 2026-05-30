/**
 * Standard Webhooks signature library for the Webhook Receiver (task 5.1).
 *
 * The Webhook Receiver authenticates every incoming webhook delivery from the
 * two MCP servers using the Standard Webhooks scheme (HMAC-SHA256 over
 * `{webhook-id}.{webhook-timestamp}.{payload}`, keyed by a symmetric `whsec_`
 * secret). Per the experimental MCP Events extension webhook delivery mode, the
 * signing secret is **per-subscription and client-supplied** — there is no
 * per-server secret. Each delivery therefore carries an `X-MCP-Subscription-Id`
 * header that selects which subscription's secret to verify against; the actual
 * secret lookup/decrypt is wired up by the handler (task 5.4) and the resolved
 * plaintext `whsec_` is passed to {@link verifyWebhook} here.
 *
 * This module is intentionally a thin, side-effect-free wrapper around the
 * `standardwebhooks` npm package (used for spec compliance and constant-time
 * signature comparison) so it can be unit- and property-tested in isolation
 * (Properties 1 and 2) and reused by the handler:
 *
 * - {@link signWebhook} — produce Standard Webhooks headers for a payload and
 *   secret (used by tests and any code that needs to emit a signed delivery).
 * - {@link verifyWebhook} — verify a payload + headers against a single
 *   per-subscription secret, returning a structured pass/fail result.
 * - {@link isTimestampWithinTolerance} — the 5-minute replay-protection window
 *   check, exposed separately so it can be reasoned about on its own.
 * - {@link getSubscriptionId} — extract the `X-MCP-Subscription-Id` routing
 *   header (case-insensitively) that selects the per-subscription secret.
 *
 * Validates Requirements 3.1, 3.2, 3.3, 17.1.
 */

import { randomUUID } from "node:crypto";

import { WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS } from "@mcp-events/shared";
import { Webhook } from "standardwebhooks";

/** The MCP routing header that selects a delivery's per-subscription secret. */
export const MCP_SUBSCRIPTION_ID_HEADER = "X-MCP-Subscription-Id";

/** The three required Standard Webhooks signature headers. */
export interface WebhookHeaders {
  "webhook-id": string;
  "webhook-timestamp": string;
  "webhook-signature": string;
  /** Allow these headers to be merged with / passed where a header bag is expected. */
  [header: string]: string;
}

/** Options controlling {@link signWebhook}. */
export interface SignWebhookOptions {
  /**
   * The unique message id placed in the `webhook-id` header. Defaults to a
   * generated `msg_<uuid>` value when omitted.
   */
  msgId?: string;
  /**
   * The delivery timestamp. Defaults to the current time. Used both to compute
   * the signature and to populate the `webhook-timestamp` header (epoch
   * seconds).
   */
  timestamp?: Date;
}

/** Why a webhook delivery failed verification. */
export type WebhookRejectionReason =
  | "missing_headers"
  | "invalid_timestamp"
  | "timestamp_out_of_tolerance"
  | "invalid_signature"
  | "invalid_secret";

/**
 * The outcome of {@link verifyWebhook}: either the delivery is authentic, or it
 * is rejected with a specific {@link WebhookRejectionReason} so the handler can
 * map it to the right HTTP status (e.g. 400 for missing headers, 401 for an
 * invalid signature, rejection for a replayed/expired timestamp).
 */
export type WebhookVerificationResult =
  | { valid: true }
  | { valid: false; reason: WebhookRejectionReason };

/**
 * Lower-case all header keys and drop undefined values so lookups are
 * case-insensitive (API Gateway / Lambda do not normalize header casing).
 */
function normalizeHeaders(
  headers: Record<string, string | undefined>,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalized[key.toLowerCase()] = value;
    }
  }
  return normalized;
}

/**
 * Sign a payload with a per-subscription `whsec_` secret, returning the three
 * Standard Webhooks headers (`webhook-id`, `webhook-timestamp`,
 * `webhook-signature`) that authenticate the delivery.
 *
 * The HMAC-SHA256 signature is computed by the `standardwebhooks` package over
 * `{webhook-id}.{epoch-seconds}.{payload}`. A fresh `msg_<uuid>` id and the
 * current time are used unless overridden via {@link SignWebhookOptions}.
 *
 * @param payload - The exact serialized request body that will be signed.
 * @param secret - The per-subscription `whsec_` secret.
 * @param options - Optional message id / timestamp overrides.
 */
export function signWebhook(
  payload: string | Buffer,
  secret: string,
  options?: SignWebhookOptions,
): WebhookHeaders {
  const webhook = new Webhook(secret);
  const msgId = options?.msgId ?? `msg_${randomUUID()}`;
  const timestamp = options?.timestamp ?? new Date();
  // The library returns the `webhook-signature` value, e.g. "v1,<base64>".
  const signature = webhook.sign(msgId, timestamp, payload);
  return {
    "webhook-id": msgId,
    "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "webhook-signature": signature,
  };
}

/**
 * Verify a webhook delivery against a single per-subscription secret
 * (Requirements 3.1, 3.2, 3.3, 17.1).
 *
 * The checks run in order so the caller can distinguish failure modes:
 * 1. all three Standard Webhooks headers must be present (`missing_headers`),
 * 2. the timestamp header must be numeric (`invalid_timestamp`),
 * 3. the timestamp must fall inside the replay-protection window
 *    (`timestamp_out_of_tolerance`),
 * 4. the secret must be a usable `whsec_` value (`invalid_secret`),
 * 5. the HMAC-SHA256 signature must match (`invalid_signature`).
 *
 * The signature comparison is delegated to the `standardwebhooks` package,
 * which performs a constant-time compare and supports the `v1,<sig>` versioned
 * signature list.
 *
 * @param payload - The raw request body as received (string or Buffer). It must
 *   be byte-for-byte what the sender signed.
 * @param headers - The incoming request headers (any casing).
 * @param secret - The plaintext per-subscription `whsec_` secret resolved from
 *   the `X-MCP-Subscription-Id` header by the caller.
 */
export function verifyWebhook(
  payload: string | Buffer,
  headers: Record<string, string | undefined>,
  secret: string,
): WebhookVerificationResult {
  const normalized = normalizeHeaders(headers);
  const id = normalized["webhook-id"];
  const timestamp = normalized["webhook-timestamp"];
  const signature = normalized["webhook-signature"];

  if (!id || !timestamp || !signature) {
    return { valid: false, reason: "missing_headers" };
  }

  const timestampSeconds = Number.parseInt(timestamp, 10);
  if (Number.isNaN(timestampSeconds)) {
    return { valid: false, reason: "invalid_timestamp" };
  }

  // Reject replayed / expired deliveries before touching the signature so a
  // stale timestamp is rejected regardless of signature validity (Property 2).
  if (!isTimestampWithinTolerance(timestampSeconds)) {
    return { valid: false, reason: "timestamp_out_of_tolerance" };
  }

  let webhook: Webhook;
  try {
    webhook = new Webhook(secret);
  } catch {
    // Empty / malformed secret — treat as unverifiable rather than a 500.
    return { valid: false, reason: "invalid_secret" };
  }

  try {
    webhook.verify(payload, {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": signature,
    });
    return { valid: true };
  } catch {
    // The timestamp was already validated above, so any failure here is a
    // signature mismatch (wrong secret, tampered payload, or bad signature).
    return { valid: false, reason: "invalid_signature" };
  }
}

/**
 * Check whether a webhook timestamp falls within the replay-protection window
 * (Requirement 3.3). Returns `false` for non-finite values and for timestamps
 * more than {@link WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS} seconds older or newer
 * than the current time.
 *
 * @param timestampSeconds - The delivery timestamp in epoch seconds.
 * @param options - Optional overrides for the reference time and tolerance,
 *   used by tests to exercise the window boundaries deterministically.
 */
export function isTimestampWithinTolerance(
  timestampSeconds: number,
  options?: { nowSeconds?: number; toleranceSeconds?: number },
): boolean {
  if (!Number.isFinite(timestampSeconds)) {
    return false;
  }
  const now = options?.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance =
    options?.toleranceSeconds ?? WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS;

  if (now - timestampSeconds > tolerance) {
    return false; // too old
  }
  if (timestampSeconds - now > tolerance) {
    return false; // too far in the future
  }
  return true;
}

/**
 * Extract the `X-MCP-Subscription-Id` routing header (case-insensitively) that
 * selects which subscription's secret a delivery must be verified against.
 * Returns `undefined` when the header is absent or empty.
 */
export function getSubscriptionId(
  headers: Record<string, string | undefined>,
): string | undefined {
  const normalized = normalizeHeaders(headers);
  const value = normalized[MCP_SUBSCRIPTION_ID_HEADER.toLowerCase()];
  return value && value.length > 0 ? value : undefined;
}
