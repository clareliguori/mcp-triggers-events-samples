/**
 * Webhook Receiver Lambda handler (task 5.4).
 *
 * This API Gateway proxy Lambda is the webhook callback endpoint that both MCP
 * servers deliver events to (the MCP Client/Host side of the experimental MCP
 * Events extension). For each delivery it:
 *
 * 1. Extracts the `X-MCP-Subscription-Id` routing header (Requirement 3.1).
 * 2. Resolves that subscription's Standard Webhooks signing secret by calling
 *    the Data API (`GET /subscriptions/{subscriptionId}`) over IAM SigV4-signed
 *    HTTPS. The Data API returns the **plaintext** `whsec_` value — it decrypts
 *    the stored ciphertext at its storage boundary — so the Webhook Receiver
 *    performs **no KMS operations** and holds no KMS permissions (Requirements
 *    17.9, 3.1).
 * 3. Verifies the Standard Webhooks HMAC-SHA256 signature against that
 *    per-subscription secret using the shared signature library (task 5.1),
 *    rejecting replayed / expired deliveries (Requirements 3.1, 3.2, 3.3).
 * 4. On success, enqueues the raw event body to SQS with the `subscriptionId`
 *    as a message attribute so the agent Lambda can route it to the right
 *    customer (Requirement 3.4), and returns 200 quickly (Requirements 3.5,
 *    19.2: validate + enqueue within 100 ms).
 *
 * HTTP status mapping (Requirements 3.2, 3.3, 3.4, 3.5). The verification
 * outcomes from {@link verifyWebhook} are split between client-error (400) and
 * unauthorized (401) deliberately:
 *
 * - missing `X-MCP-Subscription-Id` header   -> 400 (malformed request)
 * - missing Standard Webhooks headers        -> 400 (malformed request)
 * - non-numeric `webhook-timestamp`          -> 400 (malformed request)
 * - timestamp outside the tolerance window   -> 401 (replayed/expired, discard)
 * - invalid / mismatched signature           -> 401 (inauthentic, discard)
 * - empty/unusable secret for the subscription -> 401 (cannot authenticate)
 * - subscription id not found by the Data API  -> 401 (cannot authenticate)
 * - valid signature                          -> 200 (enqueued)
 *
 * Replayed/expired and bad-signature deliveries are discarded with 401 per
 * Requirements 3.2/3.3, while structurally malformed requests (no subscription
 * id, missing/garbled headers) get 400. An unexpected internal failure (for
 * example the Data API being unreachable, or SQS rejecting the send) surfaces
 * as 500 so the MCP server retries the delivery rather than silently losing the
 * event.
 */

import { Sha256 } from "@aws-crypto/sha256-js";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@smithy/signature-v4";
import type { HttpRequest } from "@smithy/types";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

import { getSubscriptionId, verifyWebhook } from "./signature.js";

/** Message attribute name carrying the subscription id on the SQS message. */
export const SUBSCRIPTION_ID_ATTRIBUTE = "subscriptionId";

/**
 * The outcome of a Data API subscription lookup: the downstream HTTP status and
 * raw response body. A 200 body is expected to be the Data API's
 * `SubscriptionResponse` JSON, which carries the decrypted plaintext `secret`.
 */
export interface SubscriptionLookupResult {
  /** Downstream HTTP status code from the Data API. */
  statusCode: number;
  /** Raw response body text (may be empty). */
  body: string;
}

/**
 * Resolves a subscription's secret from the Data API. The production
 * implementation SigV4-signs `GET /subscriptions/{id}` and delivers it with
 * `fetch`; tests override it via {@link setSubscriptionLookupForTesting} so they
 * never sign or hit the network.
 */
export type SubscriptionLookup = (
  subscriptionId: string,
) => Promise<SubscriptionLookupResult>;

/**
 * SigV4-sign `GET {DATA_API_URL}/subscriptions/{id}` for the `execute-api`
 * service and deliver it with the global `fetch` (Node 20+). Credentials come
 * from the Lambda execution role via the default provider chain. The Data API
 * returns the plaintext `whsec_` in the `secret` field (Requirement 17.9).
 */
const defaultLookup: SubscriptionLookup = async (subscriptionId) => {
  const baseUrl = dataApiUrl().replace(/\/+$/, "");
  const target = `${baseUrl}/subscriptions/${encodeURIComponent(subscriptionId)}`;
  const url = new URL(target);

  const signer = new SignatureV4({
    service: "execute-api",
    region:
      process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
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

/** Lazily-created SQS client, reused across warm invocations. */
let sqsClient: SQSClient | undefined;

/** Return the shared {@link SQSClient}, creating it on first use. */
function getSqsClient(): SQSClient {
  if (!sqsClient) {
    sqsClient = new SQSClient({});
  }
  return sqsClient;
}

/** Resolve the SQS event queue URL from the environment. */
function eventQueueUrl(): string {
  const url = process.env.EVENT_QUEUE_URL;
  if (!url) {
    // Misconfiguration — surfaces as a 500 via the handler's catch-all.
    throw new Error("EVENT_QUEUE_URL is not set");
  }
  return url;
}

/** Resolve the Data API base URL from the environment. */
function dataApiUrl(): string {
  const url = process.env.DATA_API_URL;
  if (!url) {
    // Misconfiguration — surfaces as a 500 via the handler's catch-all.
    throw new Error("DATA_API_URL is not set");
  }
  return url;
}

/** Build an API Gateway proxy response with a JSON body. */
function jsonResponse(
  statusCode: number,
  body: unknown,
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * Read the raw request body exactly as received so the bytes match what the MCP
 * server signed. API Gateway base64-encodes binary bodies; decode those back to
 * the original payload before verifying the signature or enqueueing.
 */
function readRawBody(event: APIGatewayProxyEvent): string {
  if (event.body === null || event.body === undefined) {
    return "";
  }
  if (event.isBase64Encoded) {
    return Buffer.from(event.body, "base64").toString("utf8");
  }
  return event.body;
}

/**
 * Extract the plaintext `secret` (`whsec_`) from a Data API
 * `GET /subscriptions/{id}` response body. Returns `undefined` when the body is
 * absent, not JSON, or has no string `secret` field.
 */
function extractSecret(body: string): string | undefined {
  if (body.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "secret" in parsed &&
    typeof (parsed as { secret?: unknown }).secret === "string"
  ) {
    return (parsed as { secret: string }).secret;
  }
  return undefined;
}

/**
 * API Gateway proxy Lambda entry point for incoming webhook deliveries.
 *
 * See the module docblock for the full status-code mapping. The function is
 * intentionally linear and side-effect-light so it stays well within the
 * 100 ms validate-and-enqueue budget (Requirement 19.2).
 */
export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  try {
    // 1. Routing header — selects which subscription's secret to verify.
    const headers = event.headers ?? {};
    const subscriptionId = getSubscriptionId(headers);
    if (!subscriptionId) {
      return jsonResponse(400, {
        error: "Missing X-MCP-Subscription-Id header",
      });
    }

    const payload = readRawBody(event);

    // 2. Resolve the per-subscription secret via the Data API (plaintext
    //    whsec_; the receiver performs no KMS operations — Requirement 17.9).
    const resolved = await lookup(subscriptionId);
    if (resolved.statusCode === 404) {
      // Unknown subscription id: the delivery cannot be authenticated, so it is
      // discarded like a bad signature (Requirement 3.2).
      console.warn("Unknown subscription for delivery", { subscriptionId });
      return jsonResponse(401, { error: "Unknown subscription" });
    }
    if (resolved.statusCode < 200 || resolved.statusCode >= 300) {
      // Transient/upstream failure — do NOT 200 (nothing was enqueued). A 5xx
      // lets the MCP server retry rather than lose the event.
      throw new Error(
        `Data API subscription lookup returned ${resolved.statusCode}`,
      );
    }

    const secret = extractSecret(resolved.body);
    if (secret === undefined) {
      // The subscription exists but carries no usable secret — cannot verify.
      console.warn("Subscription has no usable secret", { subscriptionId });
      return jsonResponse(401, { error: "Subscription secret unavailable" });
    }

    // 3. Verify the Standard Webhooks signature against the per-subscription
    //    secret (Requirements 3.1, 3.2, 3.3).
    const verification = verifyWebhook(payload, headers, secret);
    if (!verification.valid) {
      switch (verification.reason) {
        case "missing_headers":
        case "invalid_timestamp":
          // Structurally malformed delivery — client error (Requirement 3.1).
          return jsonResponse(400, {
            error: `Invalid webhook request: ${verification.reason}`,
          });
        case "timestamp_out_of_tolerance":
        case "invalid_signature":
        case "invalid_secret":
          // Replayed/expired or inauthentic — discard (Requirements 3.2, 3.3).
          console.warn("Rejected webhook delivery", {
            subscriptionId,
            reason: verification.reason,
          });
          return jsonResponse(401, {
            error: `Webhook signature rejected: ${verification.reason}`,
          });
      }
    }

    // 4. Enqueue the validated event with the subscriptionId attribute so the
    //    agent can resolve it to a customer (Requirement 3.4).
    await getSqsClient().send(
      new SendMessageCommand({
        QueueUrl: eventQueueUrl(),
        MessageBody: payload,
        MessageAttributes: {
          [SUBSCRIPTION_ID_ATTRIBUTE]: {
            DataType: "String",
            StringValue: subscriptionId,
          },
        },
      }),
    );

    // 5. Return 200 quickly to avoid webhook timeout/retry (Requirements 3.5,
    //    19.2).
    return jsonResponse(200, { enqueued: true });
  } catch (error) {
    // Avoid leaking internal detail; log for diagnostics. A 500 prompts the MCP
    // server to retry rather than silently dropping the event.
    console.error("Unhandled Webhook Receiver error", error);
    return jsonResponse(500, { error: "Internal Server Error" });
  }
}
