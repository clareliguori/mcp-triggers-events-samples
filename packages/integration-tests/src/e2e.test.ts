/**
 * End-to-end integration tests against a deployed MCP Events Serverless Agent
 * stack (task 13.2).
 *
 * These six flows exercise the system as a black box through its real,
 * deployed surfaces — the IAM-authorized Data API, the Standard Webhooks
 * receiver, the SQS event/dead-letter queues, and the sessions / reports S3
 * buckets — so they verify the wiring that unit and property tests cannot:
 *
 *   1. Customer registration  — create config -> subscriptions appear on both
 *      servers (Requirements 8.1).
 *   2. Earthquake event flow   — deliver a signed earthquake webhook -> it
 *      accumulates in the correct customer's session (Requirements 3.x, 4.1,
 *      4.4).
 *   3. Briefing trigger flow   — trigger a briefing -> a report is written to
 *      S3 (Requirements 4.5).
 *   4. Customer isolation      — customer A's events never appear in customer
 *      B's session (Requirements 5.1, 5.2).
 *   5. Subscription refresh    — an expiring subscription is refreshed with a
 *      later `expiresAt` (Requirements 8.2).
 *   6. DLQ behavior            — a delivery that cannot be routed lands on the
 *      dead-letter queue (Requirements 15.2, 15.6).
 *
 * ## Skip-when-not-deployed guard
 *
 * Each flow declares the stack endpoints / resources it needs and asks
 * {@link gate} whether they are configured (from env vars or a CDK outputs
 * file). When any are missing the flow is registered with `describe.skip`, so
 * `npx vitest run packages/integration-tests` still exits 0 with the e2e tests
 * reported as skipped — the standard pattern for deployed-stack integration
 * tests that must not fail CI when no stack exists. When the endpoints ARE
 * configured the same definitions run the flows for real.
 *
 * Eventual consistency: an event flows asynchronously (webhook -> SQS -> agent
 * -> S3), so the assertions poll for the expected effect with a bounded timeout
 * rather than reading once.
 */

import { describe, expect, it } from "vitest";

import { gate, requireField, type StackConfigKey } from "./config.js";
import {
  briefingTriggerEvent,
  customerConfigInput,
  earthquakeEvent,
  newCustomerId,
  newSubscriptionId,
  newWebhookSecret,
  subscriptionRecord,
} from "./fixtures.js";
import { Harness, pollUntil } from "./harness.js";

/** Generous polling budget for the asynchronous webhook -> SQS -> agent path. */
const POLL = { timeoutMs: 90_000, intervalMs: 3_000 };

/**
 * Register a flow as a real `describe` when its required stack configuration is
 * present, or `describe.skip` (with the missing keys noted in the title)
 * otherwise. The body receives a ready {@link Harness} bound to the resolved
 * config; it is only constructed on the run path.
 */
function flow(
  title: string,
  required: StackConfigKey[],
  body: (harness: Harness) => void,
): void {
  const { shouldRun, missing, config } = gate(required);
  if (!shouldRun) {
    describe.skip(`${title} [skipped: missing ${missing.join(", ")}]`, () => {
      it("requires a deployed stack", () => {
        expect(missing.length).toBeGreaterThan(0);
      });
    });
    return;
  }
  describe(title, () => {
    body(new Harness(config));
  });
}

// ---------------------------------------------------------------------------
// Flow 1: Customer registration
// ---------------------------------------------------------------------------

flow("customer registration flow", ["dataApiUrl"], (harness) => {
  it(
    "creates subscriptions on both MCP servers after a config is created",
    async () => {
      // Validates: Requirement 8.1
      const customerId = newCustomerId();
      const put = await harness.putConfig(customerId, customerConfigInput());
      expect(put.statusCode).toBe(200);

      try {
        // The Subscription Manager consumes the CustomerConfig stream INSERT
        // and subscribes on both servers; poll until both records exist.
        const subscriptions = await pollUntil(async () => {
          const result = await harness.listSubscriptions(customerId);
          if (result.statusCode !== 200) {
            return undefined;
          }
          const body = result.json as
            | { subscriptions?: { eventName?: string }[] }
            | undefined;
          const subs = body?.subscriptions ?? [];
          return subs.length >= 2 ? subs : undefined;
        }, POLL);

        expect(
          subscriptions,
          "expected 2 subscriptions to be created",
        ).toBeDefined();
        const eventNames = (subscriptions ?? []).map((s) => s.eventName).sort();
        expect(eventNames).toContain("earthquake.detected");
        expect(eventNames).toContain("briefing.trigger");
      } finally {
        await harness.deleteConfig(customerId);
      }
    },
    POLL.timeoutMs + 30_000,
  );
});

// ---------------------------------------------------------------------------
// Flow 2: Earthquake event flow
// ---------------------------------------------------------------------------

flow("earthquake event flow", ["dataApiUrl", "webhookUrl"], (harness) => {
  it(
    "accumulates a delivered earthquake in the correct customer's session",
    async () => {
      // Validates: Requirements 3.1, 4.1, 4.4
      const customerId = newCustomerId();
      const subscriptionId = newSubscriptionId();
      const secret = newWebhookSecret();

      await harness.putConfig(customerId, customerConfigInput());
      // Seed the routing record directly so the agent can resolve the
      // subscription to this customer regardless of registration timing.
      const created = await harness.createSubscription(
        customerId,
        subscriptionRecord({
          subscriptionId,
          customerId,
          secret,
          serverEndpoint: "https://usgs-mcp.integration.test",
          callbackUrl: requireField(harness.config, "webhookUrl"),
          eventName: "earthquake.detected",
        }),
      );
      expect(created.statusCode).toBe(201);

      try {
        const event = earthquakeEvent();
        const delivery = await harness.deliverWebhook(
          subscriptionId,
          secret,
          event,
        );
        expect(delivery.statusCode).toBe(200);

        const quakeId = (event.data as { earthquakeId: string }).earthquakeId;
        const messages = await pollUntil(async () => {
          const msgs = await harness.getSessionMessages(customerId);
          const haystack = JSON.stringify(msgs);
          return haystack.includes(quakeId) ? msgs : undefined;
        }, POLL);

        expect(
          messages,
          "expected the earthquake to appear in the customer's session",
        ).toBeDefined();
      } finally {
        await harness.deleteConfig(customerId);
      }
    },
    POLL.timeoutMs + 30_000,
  );
});

// ---------------------------------------------------------------------------
// Flow 3: Briefing trigger flow
// ---------------------------------------------------------------------------

flow(
  "briefing trigger flow",
  ["dataApiUrl", "webhookUrl", "reportsBucketName"],
  (harness) => {
    it(
      "writes a briefing report to S3 when a briefing is triggered",
      async () => {
        // Validates: Requirement 4.5
        const customerId = newCustomerId();
        const quakeSubId = newSubscriptionId();
        const briefingSubId = newSubscriptionId();
        const quakeSecret = newWebhookSecret();
        const briefingSecret = newWebhookSecret();
        const callbackUrl = requireField(harness.config, "webhookUrl");

        await harness.putConfig(customerId, customerConfigInput());
        await harness.createSubscription(
          customerId,
          subscriptionRecord({
            subscriptionId: quakeSubId,
            customerId,
            secret: quakeSecret,
            serverEndpoint: "https://usgs-mcp.integration.test",
            callbackUrl,
            eventName: "earthquake.detected",
          }),
        );
        await harness.createSubscription(
          customerId,
          subscriptionRecord({
            subscriptionId: briefingSubId,
            customerId,
            secret: briefingSecret,
            serverEndpoint: "https://scheduler-mcp.integration.test",
            callbackUrl,
            eventName: "briefing.trigger",
          }),
        );

        try {
          // Seed at least one earthquake so the briefing has activity to report
          // on (the agent skips an empty briefing by design).
          const quake = earthquakeEvent();
          await harness.deliverWebhook(quakeSubId, quakeSecret, quake);
          const quakeId = (quake.data as { earthquakeId: string }).earthquakeId;
          await pollUntil(async () => {
            const msgs = await harness.getSessionMessages(customerId);
            return JSON.stringify(msgs).includes(quakeId) ? msgs : undefined;
          }, POLL);

          // Trigger the briefing and wait for a report to land in S3.
          const trigger = await harness.deliverWebhook(
            briefingSubId,
            briefingSecret,
            briefingTriggerEvent(customerId),
          );
          expect(trigger.statusCode).toBe(200);

          const report = await pollUntil(async () => {
            const result = await harness.listReports(customerId, true);
            if (result.statusCode !== 200) {
              return undefined;
            }
            const body = result.json as
              | { reports?: { reportId: string }[] }
              | undefined;
            const reports = body?.reports ?? [];
            return reports.length > 0 ? reports[0] : undefined;
          }, POLL);

          expect(
            report,
            "expected a briefing report to be written",
          ).toBeDefined();

          // Verify the report object actually exists in the reports S3 bucket.
          const fromS3 = await harness.readReportFromS3(
            customerId,
            (report as { reportId: string }).reportId,
          );
          expect(fromS3?.customerId).toBe(customerId);
        } finally {
          await harness.deleteConfig(customerId);
        }
      },
      POLL.timeoutMs * 2 + 30_000,
    );
  },
);

// ---------------------------------------------------------------------------
// Flow 4: Customer isolation
// ---------------------------------------------------------------------------

flow("customer isolation", ["dataApiUrl", "webhookUrl"], (harness) => {
  it(
    "does not leak customer A's events into customer B's session",
    async () => {
      // Validates: Requirements 5.1, 5.2
      const customerA = newCustomerId();
      const customerB = newCustomerId();
      const subA = newSubscriptionId();
      const secretA = newWebhookSecret();
      const callbackUrl = requireField(harness.config, "webhookUrl");

      await harness.putConfig(customerA, customerConfigInput());
      await harness.putConfig(customerB, customerConfigInput());
      await harness.createSubscription(
        customerA,
        subscriptionRecord({
          subscriptionId: subA,
          customerId: customerA,
          secret: secretA,
          serverEndpoint: "https://usgs-mcp.integration.test",
          callbackUrl,
          eventName: "earthquake.detected",
        }),
      );

      try {
        // Deliver an earthquake ONLY on customer A's subscription.
        const event = earthquakeEvent();
        const quakeId = (event.data as { earthquakeId: string }).earthquakeId;
        await harness.deliverWebhook(subA, secretA, event);

        // Wait until A's session has the earthquake.
        const aMessages = await pollUntil(async () => {
          const msgs = await harness.getSessionMessages(customerA);
          return JSON.stringify(msgs).includes(quakeId) ? msgs : undefined;
        }, POLL);
        expect(
          aMessages,
          "customer A should have the earthquake",
        ).toBeDefined();

        // Customer B's session must NOT contain customer A's earthquake.
        const bMessages = await harness.getSessionMessages(customerB);
        expect(JSON.stringify(bMessages)).not.toContain(quakeId);
      } finally {
        await harness.deleteConfig(customerA);
        await harness.deleteConfig(customerB);
      }
    },
    POLL.timeoutMs + 30_000,
  );
});

// ---------------------------------------------------------------------------
// Flow 5: Subscription refresh
// ---------------------------------------------------------------------------

flow("subscription refresh", ["dataApiUrl"], (harness) => {
  it(
    "refreshes an expiring subscription with a later expiresAt",
    async () => {
      // Validates: Requirement 8.2
      const customerId = newCustomerId();
      const subscriptionId = newSubscriptionId();
      const secret = newWebhookSecret();

      await harness.putConfig(customerId, customerConfigInput());
      // Create a subscription that is already close to expiry.
      const created = await harness.createSubscription(
        customerId,
        subscriptionRecord({
          subscriptionId,
          customerId,
          secret,
          serverEndpoint: "https://usgs-mcp.integration.test",
          callbackUrl: "https://webhook.integration.test",
          eventName: "earthquake.detected",
          ttlSeconds: 60,
        }),
      );
      expect(created.statusCode).toBe(201);

      try {
        const before = await harness.getSubscription(subscriptionId);
        expect(before.statusCode).toBe(200);
        const beforeExpiry = Date.parse(
          (before.json as { expiresAt: string }).expiresAt,
        );

        // Simulate the Subscription Manager's refresh by pushing expiresAt
        // and lastRefreshedAt forward (the same PUT the manager issues).
        const now = new Date();
        const refreshedExpiry = new Date(now.getTime() + 1800 * 1000);
        const update = await harness.putSubscription(subscriptionId, {
          expiresAt: refreshedExpiry.toISOString(),
          lastRefreshedAt: now.toISOString(),
        });
        expect(update.statusCode).toBe(200);

        const afterExpiry = Date.parse(
          (update.json as { expiresAt: string }).expiresAt,
        );
        expect(afterExpiry).toBeGreaterThan(beforeExpiry);
      } finally {
        await harness.deleteConfig(customerId);
      }
    },
    POLL.timeoutMs,
  );
});

// ---------------------------------------------------------------------------
// Flow 6: DLQ behavior on simulated failures
// ---------------------------------------------------------------------------

flow(
  "DLQ behavior on simulated failures",
  ["dataApiUrl", "webhookUrl", "deadLetterQueueUrl"],
  (harness) => {
    it(
      "routes an un-routable delivery to the dead-letter queue",
      async () => {
        // Validates: Requirements 15.2, 15.6
        //
        // Deliver a body that is signature-valid for a REAL subscription (so
        // the Webhook Receiver accepts and enqueues it) but is NOT a valid MCP
        // event payload. The agent fails to parse it as an event -> permanent
        // failure -> dead-lettered as a malformed message (Error Scenario 9 /
        // Requirement 15.6). Signing with an unknown subscription instead would
        // be rejected at the receiver (401) and never reach the agent's DLQ
        // path, so we exercise the agent path here.
        const customerId = newCustomerId();
        const realSubId = newSubscriptionId();
        const secret = newWebhookSecret();

        await harness.putConfig(customerId, customerConfigInput());
        await harness.createSubscription(
          customerId,
          subscriptionRecord({
            subscriptionId: realSubId,
            customerId,
            secret,
            serverEndpoint: "https://usgs-mcp.integration.test",
            callbackUrl: requireField(harness.config, "webhookUrl"),
            eventName: "earthquake.detected",
          }),
        );

        try {
          const malformedBody = JSON.stringify({ not: "an-mcp-event" });
          const delivery = await harness.deliverRawWebhook(
            realSubId,
            secret,
            malformedBody,
          );
          expect(delivery.statusCode).toBe(200);

          const dlqMessage = await pollUntil(async () => {
            const messages = await harness.receiveDeadLetterMessages();
            const match = messages.find((m) => m.body.includes("an-mcp-event"));
            return match;
          }, POLL);

          expect(
            dlqMessage,
            "expected the malformed event on the dead-letter queue",
          ).toBeDefined();
          expect(dlqMessage?.dlqReason).toBeDefined();
        } finally {
          await harness.deleteConfig(customerId);
        }
      },
      POLL.timeoutMs + 30_000,
    );
  },
);
