/**
 * Signed webhook delivery shared by both MCP servers.
 *
 * Builds an MCP event payload, computes the Standard Webhooks signature headers
 * once up front, and POSTs the serialized body to a subscription's callback
 * with exponential-backoff retries. The per-subscription secret is decrypted in
 * memory with `kms:Decrypt` only for the duration of the delivery.
 *
 * The event is BUILT BY THE CALLER (so its `timestamp`/`eventId`/`cursor` are
 * fixed by the domain) and passed to {@link deliverEvent}; this module serializes
 * and signs it once so every retry sends byte-identical, still-in-tolerance
 * content.
 */

import { randomUUID } from "node:crypto";

import type {
  BriefingTriggerData,
  EarthquakeDetectedData,
  McpEventPayload,
  WebhookSubscription,
} from "@mcp-events/shared";
import {
  decryptSubscriptionSecret,
  MCP_SUBSCRIPTION_ID_HEADER,
  signWebhook,
} from "@mcp-events/shared";

import { getFetchImpl, getKmsClient, getSleepImpl } from "./clients.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Re-export the routing header that selects a delivery's per-subscription
 * secret so the core package's public surface is unchanged for the server
 * handlers (`export { MCP_SUBSCRIPTION_ID_HEADER } from "@mcp-events/mcp-server-core"`).
 */
export { MCP_SUBSCRIPTION_ID_HEADER };

/**
 * Exponential backoff schedule for webhook delivery retries (Requirement 15.1):
 * after the initial attempt fails, retry up to three more times, waiting 1s,
 * 5s, then 30s before each retry. The total worst-case wait (~36s) stays inside
 * the Webhook Receiver's 5-minute Standard Webhooks timestamp tolerance, so the
 * single signature computed up front remains valid across all retries.
 */
export const WEBHOOK_RETRY_DELAYS_MS: readonly number[] = [1000, 5000, 30000];

// ---------------------------------------------------------------------------
// Event construction
// ---------------------------------------------------------------------------

/**
 * Build an MCP event payload for one piece of domain data. The caller supplies
 * the event `name`, the typed `data`, and an opaque `cursor` (a stable,
 * per-event ordering/resumption key — the earthquake id for MCP Server 1, the
 * `customer:scheduledTime` pair for MCP Server 2). A fresh `eventId` is minted
 * and the `timestamp` is stamped from `now`.
 */
export function buildMcpEvent<
  TData extends EarthquakeDetectedData | BriefingTriggerData,
>(
  name: McpEventPayload["name"],
  data: TData,
  cursor: string,
  now: Date = new Date(),
): McpEventPayload<TData> {
  return {
    eventId: randomUUID(),
    name,
    timestamp: now.toISOString(),
    data,
    cursor,
  };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** Outcome of a delivery attempt sequence. */
export interface DeliveryOutcome {
  delivered: boolean;
  /** Total number of HTTP attempts made (1 initial + up to 3 retries). */
  attempts: number;
  /** The `eventId` of the event that was delivered. */
  eventId: string;
}

/**
 * Deliver one pre-built MCP event to one subscription as a signed webhook
 * (Requirements 1.3/2.2, 14.4, 14.5), retrying with exponential backoff on
 * failure (Requirement 15.1).
 *
 * The subscription's secret is decrypted once, the (already-built) event
 * serialized once, and the signature computed once up front so every retry
 * sends byte-identical, still-in-tolerance content. A non-2xx response or a
 * thrown network error counts as a failed attempt; between attempts the function
 * sleeps for the next {@link WEBHOOK_RETRY_DELAYS_MS} delay via the injected
 * sleep seam.
 */
export async function deliverEvent(
  subscription: WebhookSubscription,
  event: McpEventPayload,
  now: Date = new Date(),
): Promise<DeliveryOutcome> {
  const secret = await decryptSubscriptionSecret(
    getKmsClient(),
    subscription.subscriptionId,
    subscription.encryptedSecret,
  );

  const payload = JSON.stringify(event);
  const signatureHeaders = signWebhook(payload, secret, { timestamp: now });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [MCP_SUBSCRIPTION_ID_HEADER]: subscription.subscriptionId,
    ...signatureHeaders,
  };

  const fetchImpl = getFetchImpl();
  const sleepImpl = getSleepImpl();

  // 1 initial attempt + one retry per backoff delay.
  const maxAttempts = WEBHOOK_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let succeeded = false;
    try {
      const response = await fetchImpl(subscription.callbackUrl, {
        method: "POST",
        headers,
        body: payload,
      });
      succeeded = response.ok;
      if (!succeeded) {
        console.warn("Webhook delivery returned non-2xx", {
          subscriptionId: subscription.subscriptionId,
          status: response.status,
          attempt: attempt + 1,
        });
      }
    } catch (error) {
      console.warn("Webhook delivery threw", {
        subscriptionId: subscription.subscriptionId,
        attempt: attempt + 1,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (succeeded) {
      return {
        delivered: true,
        attempts: attempt + 1,
        eventId: event.eventId,
      };
    }

    // Back off before the next retry (no wait after the final attempt).
    if (attempt < WEBHOOK_RETRY_DELAYS_MS.length) {
      await sleepImpl(WEBHOOK_RETRY_DELAYS_MS[attempt]);
    }
  }

  return { delivered: false, attempts: maxAttempts, eventId: event.eventId };
}
