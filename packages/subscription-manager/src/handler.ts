/**
 * Subscription Manager Lambda entry point (task 10.4).
 *
 * The Subscription Manager (design Component 5) runs on a single Lambda that is
 * **dual-triggered** and serves the two halves of the subscription lifecycle:
 *
 * 1. **DynamoDB Stream trigger (CustomerConfig table) — registration.** When the
 *    Data API writes a new `CustomerConfig`, the table's stream wakes this
 *    Lambda with an `INSERT` record. The event is routed to
 *    {@link handleRegistrationStream} (register.ts, task 10.1), which subscribes
 *    each new active customer on both MCP servers and stores the resulting
 *    {@link WebhookSubscription} records via the Data API (Requirements 8.1,
 *    14.6). Its `{ batchItemFailures }` result is returned directly as the
 *    Lambda's `DynamoDBBatchResponse` so the event source's
 *    `reportBatchItemFailures` redrives only the records whose registration
 *    failed after retries (the rest are deleted from the stream shard).
 * 2. **EventBridge scheduled trigger (every 5 min) — refresh.** Anything that is
 *    not a DynamoDB Stream invocation (the scheduled tick) is routed to
 *    {@link refreshExpiringSubscriptions} (refresh.ts, task 10.2), which keeps
 *    every active customer's subscriptions alive before they expire and
 *    re-creates any that are missing (Requirements 8.2, 8.5, 15.3). The refresh
 *    path returns no HTTP/batch result; its {@link RefreshSummary} is logged for
 *    operational visibility (Requirement 8.4).
 *
 * Trigger-source detection mirrors the `isApiGatewayEvent` convention used by
 * the MCP servers' shared dual-trigger dispatch: rather than inspecting Lambda
 * `context`, the entry point structurally distinguishes the two event shapes —
 * a DynamoDB Stream event carries a `Records` array of `aws:dynamodb` records,
 * whereas an EventBridge scheduled event does not (see
 * {@link isDynamoDBStreamEvent}).
 *
 * The MCP client connections (`StreamableHTTPClientWithSigV4Transport`) and the
 * Data API SigV4 calls are wired inside register.ts and refresh.ts; this module
 * only detects the trigger source and dispatches, keeping the entry point thin
 * and fully unit-testable (the routed modules expose their own `setXForTesting`
 * seams — see `handler.test.ts`).
 */

import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from "aws-lambda";

import { handleRegistrationStream } from "./register.js";
import { refreshExpiringSubscriptions } from "./refresh.js";

/**
 * Whether the invocation is a DynamoDB Stream event (the registration trigger)
 * rather than an EventBridge scheduled event (the refresh trigger).
 *
 * A DynamoDB Stream event is an object with a `Records` array; each record (when
 * present) is an `aws:dynamodb` stream record carrying a `dynamodb` field. An
 * EventBridge scheduled event has no `Records` array (it exposes `source` /
 * `detail-type` / `detail` instead), so the presence of a well-formed `Records`
 * array is the discriminator. An empty `Records` array is still treated as a
 * (no-op) stream invocation.
 */
export function isDynamoDBStreamEvent(
  event: unknown,
): event is DynamoDBStreamEvent {
  if (typeof event !== "object" || event === null) {
    return false;
  }
  const records = (event as { Records?: unknown }).Records;
  if (!Array.isArray(records)) {
    return false;
  }
  return records.every(
    (record) =>
      typeof record === "object" &&
      record !== null &&
      ((record as { eventSource?: unknown }).eventSource === "aws:dynamodb" ||
        "dynamodb" in record),
  );
}

/**
 * Dual-trigger Lambda entry point. A DynamoDB Stream event is routed to the
 * registration logic and its batch-item-failure report is returned so failed
 * records are redriven; anything else (the EventBridge scheduled tick) runs a
 * subscription refresh and logs the resulting summary, returning no batch
 * response.
 */
export const handler = async (
  event: unknown,
): Promise<DynamoDBBatchResponse | void> => {
  if (isDynamoDBStreamEvent(event)) {
    // Registration: returns { batchItemFailures } so the stream event source
    // (reportBatchItemFailures) redrives only the records that failed after
    // their per-customer retries (Requirements 8.1, 14.6).
    return handleRegistrationStream(event);
  }

  // Refresh: the scheduled tick has no per-record result to report; log the
  // aggregate outcome for alerting (Requirements 8.2, 8.4, 8.5, 15.3).
  const summary = await refreshExpiringSubscriptions();
  console.log("Subscription refresh complete", {
    customersProcessed: summary.customersProcessed,
    refreshed: summary.refreshed,
    recreated: summary.recreated,
    failed: summary.failed,
  });
};
