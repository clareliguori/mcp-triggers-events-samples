/**
 * Awaitable webhook delivery for serverless (Lambda) poll/schedule paths.
 *
 * Uses the SDK's `computeWebhookSignature` and Standard Webhooks headers to
 * sign and deliver event payloads to webhook subscriptions from our
 * DynamoDBWebhookSubscriptionStore. Unlike `McpServer.emitEvent()` (which is
 * fire-and-forget), this module awaits each delivery so the Lambda handler does
 * not return before HTTP POSTs complete.
 */

import { randomUUID } from "node:crypto";

import {
  computeWebhookSignature,
  WEBHOOK_ID_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SUBSCRIPTION_ID_HEADER,
} from "@modelcontextprotocol/server";
import type { WebhookSubscriptionData } from "@modelcontextprotocol/server";

import { getFetchImpl, getSleepImpl } from "./clients.js";

/** Backoff delays: 1s, 2s (3 total attempts). */
const RETRY_DELAYS_MS = [1000, 2000] as const;

/**
 * Deliver a signed webhook to a subscription. Builds the event occurrence in
 * the SDK's wire format, signs with Standard Webhooks, and POSTs to the
 * callback URL with retries.
 *
 * @returns `true` when the webhook was delivered (2xx response).
 */
export async function deliverWebhookToSubscription(
  sub: WebhookSubscriptionData,
  eventName: string,
  data: Record<string, unknown>,
  cursor: string,
): Promise<boolean> {
  const eventId = `evt_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const occurrence = {
    eventId,
    name: eventName,
    timestamp: new Date().toISOString(),
    data,
    cursor,
  };
  const body = JSON.stringify(occurrence);
  const timestamp = Math.floor(Date.now() / 1000);

  const sigs = await Promise.all(
    sub.secrets.map((s) => computeWebhookSignature(s, eventId, timestamp, body)),
  );

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [WEBHOOK_ID_HEADER]: eventId,
    [WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
    [WEBHOOK_SIGNATURE_HEADER]: sigs.join(" "),
    [WEBHOOK_SUBSCRIPTION_ID_HEADER]: sub.id,
  };

  const fetchImpl = getFetchImpl();
  const sleepImpl = getSleepImpl();
  const maxAttempts = RETRY_DELAYS_MS.length + 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetchImpl(sub.url, {
        method: "POST",
        headers,
        body,
      });
      if (response.ok) return true;
      console.warn("Webhook delivery returned non-2xx", {
        subscriptionId: sub.id,
        status: response.status,
        attempt: attempt + 1,
      });
    } catch (error) {
      console.warn("Webhook delivery threw", {
        subscriptionId: sub.id,
        attempt: attempt + 1,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (attempt < RETRY_DELAYS_MS.length) {
      await sleepImpl(RETRY_DELAYS_MS[attempt]);
    }
  }
  return false;
}
