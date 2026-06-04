/**
 * Serverless Agent Lambda entry point (task 9.10).
 *
 * This is the SQS-triggered handler that ties together the building blocks from
 * tasks 9.1-9.8 into the full event-processing pipeline (design Component 4,
 * Requirements 4.1-4.7, 6.3, 15.2, 15.5). The Webhook Receiver validates and
 * enqueues each MCP event; this handler is woken with an SQS batch of **one**
 * record (the AgentStack configures `batchSize: 1` and
 * `reportBatchItemFailures: true`) and:
 *
 * 1. **Routes** the record to a customer ({@link routeRecord}, task 9.3):
 *    parses the event, extracts the `subscriptionId`, and resolves it to a
 *    `customerId` via the Data API. A permanently un-routable record (malformed
 *    message, unknown subscription) is dead-lettered by the router and treated
 *    here as handled — no batch failure (Requirement 15.6).
 * 2. **Loads** the customer's {@link CustomerConfig} from the Data API
 *    ({@link loadCustomerConfig}, task 9.10). A `customerId` with no config
 *    (deleted customer) is logged and dropped — no retry (design Error
 *    Scenario 8).
 * 3. **Locks** the customer ({@link withLock}, task 9.1) so the
 *    restore-modify-persist of the session is serialized (Requirements 4.2,
 *    6.1). A lock acquisition timeout becomes a **batch item failure** so SQS
 *    redelivers after the visibility timeout (Requirements 6.3, Error Scenario
 *    10).
 * 4. Inside the lock, **recovers** a corrupted session if necessary
 *    ({@link prepareSession}, task 9.10): the corrupt object is archived aside
 *    and processing continues from a fresh session (Requirement 15.5, Error
 *    Scenario 5).
 * 5. **Dispatches** by event type (Requirement 4.3-4.6):
 *    - `earthquake.detected` -> {@link processEarthquakeEvent} (task 9.4):
 *      inject the earthquake as a user message, invoke the LLM, persist.
 *    - `briefing.trigger`    -> {@link processBriefingEvent} (task 9.8): invoke
 *      the LLM with the full conversation history; it calls `save_report`,
 *      which persists the report via the Data API; then persist the session.
 *
 * **Partial batch failure** (Requirement 15.2): any thrown error while
 * processing a record adds that record's `messageId` to the returned
 * {@link SQSBatchResponse.batchItemFailures}, so only the failed message is
 * redelivered (and eventually redriven to the DLQ) while successful messages in
 * the (size-1) batch are deleted. Lock contention and transient downstream
 * failures (Data API, S3, LLM) therefore retry; permanent routing failures are
 * dead-lettered without consuming the retry budget.
 *
 * ## Testability
 *
 * The handler composes the same module-level test seams the building blocks
 * expose (`setSubscriptionLookupForTesting`, `setSqsClientForTesting`,
 * `setConfigLookupForTesting`, `setModelForTesting`, `setS3ClientForTesting`,
 * `setReportWriterForTesting`, `setLockClientForTesting`), so the whole pipeline
 * is unit-testable with no real AWS or LLM access (see `handler.test.ts`).
 */

import type {
  EarthquakeDetectedData,
  BriefingTriggerData,
  McpEventPayload,
} from "@mcp-events/shared";
import type {
  SQSBatchResponse,
  SQSEvent,
  SQSHandler,
  SQSRecord,
} from "aws-lambda";

import { processEarthquakeEvent } from "./accumulate.js";
import { processBriefingEvent } from "./briefing.js";
import { loadCustomerConfig } from "./config.js";
import { LockAcquisitionTimeoutError, withLock } from "./lock.js";
import { prepareSession } from "./recovery.js";
import { routeRecord, type RoutedEvent } from "./router.js";

/**
 * Process one routed event for its customer, inside the per-customer lock
 * (Requirements 4.2-4.6, 6.1, 15.5).
 *
 * The corrupted-session recovery runs first (and inside the lock) so the
 * archive-then-fresh-restore is serialized with any concurrent invocation for
 * the same customer. Dispatch then branches on the validated event type.
 */
async function processRoutedEvent(routed: RoutedEvent): Promise<void> {
  const { customerId, event, eventType } = routed;

  // Load the customer's config from the Data API (Requirements 4.4, 4.5, 11.2).
  // A missing config (deleted customer) is handled, not retryable (Error
  // Scenario 8): log and drop without acquiring the lock or touching S3.
  const config = await loadCustomerConfig(customerId);
  if (config === null) {
    console.log("Dropping event for customer with no config", {
      customerId,
      subscriptionId: routed.subscriptionId,
      eventId: event.eventId,
      eventType,
    });
    return;
  }

  // Acquire the per-customer lock for the whole restore-modify-persist critical
  // section (Requirements 4.2, 6.1). A timeout propagates as
  // LockAcquisitionTimeoutError and is mapped to a batch item failure by the
  // caller (Requirement 6.3).
  await withLock(customerId, async () => {
    // Recover a corrupted session before the agent restores it
    // (Requirement 15.5). On recovery the corrupt object is archived aside and
    // processing continues from a fresh (empty) session.
    await prepareSession(customerId);

    if (eventType === "earthquake.detected") {
      await processEarthquakeEvent({
        customerId,
        config,
        event: event as McpEventPayload<EarthquakeDetectedData>,
      });
      return;
    }

    // eventType === "briefing.trigger"
    await processBriefingEvent({
      customerId,
      config,
      event: event as McpEventPayload<BriefingTriggerData>,
    });
  });
}

/**
 * Process a single SQS record, returning `true` when it was handled
 * successfully (delete from the queue) or `false` when it must be retried
 * (reported as a batch item failure, Requirement 15.2).
 *
 * A dead-lettered routing outcome counts as handled — the router already moved
 * the record to the DLQ, so retrying the main queue would be pointless
 * (Requirement 15.6). Any thrown error (lock timeout, transient Data API / S3 /
 * LLM failure) is logged and reported as a failure so SQS redelivers.
 */
async function processRecord(record: SQSRecord): Promise<boolean> {
  try {
    const outcome = await routeRecord(record);
    if (outcome.status === "dead-lettered") {
      // Already sent to the DLQ by the router; treat as handled.
      return true;
    }

    await processRoutedEvent(outcome.event);
    return true;
  } catch (error) {
    if (error instanceof LockAcquisitionTimeoutError) {
      // Contention — let SQS redeliver after the visibility timeout
      // (Requirements 6.3, Error Scenario 10).
      console.warn("Lock acquisition timed out; will retry", {
        messageId: record.messageId,
        customerId: error.customerId,
      });
    } else {
      // Transient/unexpected failure — retry via SQS, eventually the DLQ
      // (Requirement 15.2, Error Scenario 2).
      console.error("Failed to process SQS record; will retry", {
        messageId: record.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return false;
  }
}

/**
 * SQS event handler. With a batch size of 1 the batch holds a single record,
 * but the implementation handles any batch size and returns a partial-batch
 * response so only failed records are redelivered (Requirement 15.2).
 */
export const handler: SQSHandler = async (
  event: SQSEvent,
): Promise<SQSBatchResponse> => {
  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];

  for (const record of event.Records) {
    const handled = await processRecord(record);
    if (!handled) {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
