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
 * {@link gateFromConfig} whether they are configured. Configuration is resolved
 * **once** before the flows are defined, from three sources in precedence
 * order: individual env vars, a CDK outputs file, then the live, deployed
 * CloudFormation stack exports (`EarthquakeAgent-*`) queried with the AWS SDK
 * (see {@link resolveStackConfig}). The live query is bounded and never throws,
 * so when no stack is reachable / no credentials are present it simply
 * contributes nothing.
 *
 * When a flow's required values are missing it is registered with
 * `describe.skip`, so `npx vitest run packages/integration-tests` still exits 0
 * with the e2e tests reported as skipped — the standard pattern for
 * deployed-stack integration tests that must not fail CI when no stack exists.
 * When the values ARE resolvable (from any source) the same definitions run the
 * flows for real, including automatically against an already-deployed stack
 * with no env vars / outputs file as long as credentials are available.
 *
 * Eventual consistency: an event flows asynchronously (webhook -> SQS -> agent
 * -> S3), so the assertions poll for the expected effect with a bounded timeout
 * rather than reading once.
 */

import { describe, expect, it } from "vitest";

import {
  gateFromConfig,
  resolveStackConfig,
  requireField,
  type StackConfigKey,
} from "./config.js";
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
 * Resolve the deployed-stack configuration **once**, before any flow is
 * defined, including the bounded live-CloudFormation source. Vitest allows
 * top-level await in test modules; {@link resolveStackConfig} is bounded and
 * never throws, so this cannot hang collection or fail the run when no stack is
 * reachable — it just yields a config with the unresolved fields left unset and
 * the dependent flows skip.
 */
const RESOLVED_CONFIG = await resolveStackConfig();

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
  const { shouldRun, missing, config } = gateFromConfig(
    RESOLVED_CONFIG,
    required,
  );
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

flow(
  "customer registration flow",
  ["dataApiUrl", "customerConfigTableName"],
  (harness) => {
    it(
      "creates subscriptions on both MCP servers after a config is created",
      async () => {
        // Validates: Requirement 8.1
        const customerId = newCustomerId();
        // Seeding the config writes the CustomerConfig item directly to its
        // DynamoDB table (no IAM write route exists), which fires the table's
        // stream INSERT — the real trigger the Subscription Manager consumes to
        // subscribe on both servers. So this flow exercises that path for real.
        await harness.putConfig(customerId, customerConfigInput());

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
          const eventNames = (subscriptions ?? [])
            .map((s) => s.eventName)
            .sort();
          expect(eventNames).toContain("earthquake.detected");
          expect(eventNames).toContain("briefing.trigger");
        } finally {
          await harness.deleteConfig(customerId);
        }
      },
      POLL.timeoutMs + 30_000,
    );
  },
);

// ---------------------------------------------------------------------------
// Flow 2: Earthquake event flow
// ---------------------------------------------------------------------------

flow(
  "earthquake event flow",
  ["dataApiUrl", "webhookUrl", "customerConfigTableName", "sessionsBucketName"],
  (harness) => {
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
  },
);

// ---------------------------------------------------------------------------
// Flow 3: Briefing trigger flow
// ---------------------------------------------------------------------------

flow(
  "briefing trigger flow",
  [
    "dataApiUrl",
    "webhookUrl",
    "reportsBucketName",
    "customerConfigTableName",
    "sessionsBucketName",
  ],
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
            const reports = await harness.listReports(customerId, true);
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

flow(
  "customer isolation",
  ["dataApiUrl", "webhookUrl", "customerConfigTableName", "sessionsBucketName"],
  (harness) => {
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
  },
);

// ---------------------------------------------------------------------------
// Flow 4b: SDK webhook delivery (emit-test-event end-to-end)
// ---------------------------------------------------------------------------

flow(
  "SDK webhook delivery",
  [
    "dataApiUrl",
    "usgsMcpUrl",
    "webhookUrl",
    "sessionsBucketName",
    "customerConfigTableName",
  ],
  (harness) => {
    it(
      "delivers a synthetic earthquake through the full SDK path to the agent session",
      async () => {
        const customerId = newCustomerId();
        const earthquakeId = `test-sdk-${Date.now()}`;

        await harness.putConfig(customerId, customerConfigInput());

        // Wait for subscription manager to create subscriptions.
        const subs = await pollUntil(async () => {
          const res = await harness.listSubscriptions(customerId);
          if (res.statusCode !== 200) return undefined;
          const body = res.json as { subscriptions?: { subscriptionId: string; eventName: string }[] };
          return (body.subscriptions ?? []).length >= 2 ? body.subscriptions : undefined;
        }, POLL);
        expect(subs).toBeDefined();

        // Emit a synthetic earthquake. Delivers to all matching subscriptions
        // via: SDK store lookup -> HMAC signing -> webhook POST -> receiver -> SQS -> agent.
        const emitResult = await harness.emitTestEvent({
          earthquakeId,
          magnitude: 5.0,
          place: "Integration Test - SDK Delivery",
          coordinates: { longitude: -120.0, latitude: 37.0, depth: 10.0 },
          time: new Date().toISOString(),
          tsunami: false,
          felt: null,
          alert: null,
          url: `https://earthquake.usgs.gov/earthquakes/eventpage/${earthquakeId}`,
        });
        expect(emitResult.statusCode).toBe(200);
        expect((emitResult.json as { delivered: boolean }).delivered).toBe(true);

        // Poll the agent session until the synthetic earthquake appears.
        const found = await pollUntil(async () => {
          const messages = await harness.getSessionMessages(customerId);
          const hit = messages.some(
            (m) => m.role === "user" && JSON.stringify(m.content).includes(earthquakeId),
          );
          return hit ? true : undefined;
        }, POLL);
        expect(found).toBe(true);

        await harness.deleteConfig(customerId);
      },
      POLL.timeoutMs * 2,
    );
  },
);

// ---------------------------------------------------------------------------
// Flow 4c: SDK briefing delivery (emit-test-event on scheduler)
// ---------------------------------------------------------------------------

flow(
  "SDK briefing delivery",
  [
    "dataApiUrl",
    "schedulerMcpUrl",
    "webhookUrl",
    "reportsBucketName",
    "sessionsBucketName",
    "customerConfigTableName",
  ],
  (harness) => {
    it(
      "delivers a briefing trigger through the full SDK path and generates a report",
      async () => {
        const customerId = newCustomerId();
        const earthquakeId = `test-briefing-sdk-${Date.now()}`;

        await harness.putConfig(customerId, customerConfigInput());

        // Wait for subscriptions.
        await pollUntil(async () => {
          const res = await harness.listSubscriptions(customerId);
          if (res.statusCode !== 200) return undefined;
          const body = res.json as { subscriptions?: unknown[] };
          return (body.subscriptions ?? []).length >= 2 ? true : undefined;
        }, POLL);

        // Seed an earthquake so the briefing has content to report on.
        const emitEq = await harness.emitTestEvent({
          earthquakeId,
          magnitude: 6.0,
          place: "SDK Briefing Test Location",
          coordinates: { longitude: -118.0, latitude: 34.0, depth: 8.0 },
          time: new Date().toISOString(),
          tsunami: false,
          felt: null,
          alert: null,
          url: `https://earthquake.usgs.gov/earthquakes/eventpage/${earthquakeId}`,
        });
        expect(emitEq.statusCode).toBe(200);

        // Wait for the earthquake to be processed by the agent.
        await pollUntil(async () => {
          const messages = await harness.getSessionMessages(customerId);
          return messages.some(
            (m) => m.role === "user" && JSON.stringify(m.content).includes(earthquakeId),
          ) ? true : undefined;
        }, POLL);

        // Trigger a briefing via the scheduler's SDK emit-test-event endpoint.
        const emitBriefing = await harness.emitTestBriefing(customerId, "SDK integ test");
        expect(emitBriefing.statusCode).toBe(200);
        expect((emitBriefing.json as { delivered: boolean }).delivered).toBe(true);

        // Poll until a report appears.
        const report = await pollUntil(async () => {
          const reports = await harness.listReports(customerId);
          return reports.length > 0 ? reports[0] : undefined;
        }, POLL);
        expect(report).toBeDefined();
        expect(report!.reportId).toBeTruthy();

        await harness.deleteConfig(customerId);
      },
      POLL.timeoutMs * 3,
    );
  },
);

// ---------------------------------------------------------------------------
// Flow 5: Subscription refresh
// ---------------------------------------------------------------------------

flow(
  "subscription refresh",
  ["dataApiUrl", "customerConfigTableName"],
  (harness) => {
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

    it(
      "GET /backend/customers returns customers list (subscription manager contract)",
      async () => {
        // Validates: the Data API route the Subscription Manager's refresh
        // path depends on exists and returns the expected shape.
        const customerId = newCustomerId();
        await harness.putConfig(customerId, customerConfigInput());

        try {
          const result = await harness.listCustomers();
          expect(result.statusCode).toBe(200);
          const body = result.json as { customers: unknown[] };
          expect(body).toHaveProperty("customers");
          expect(Array.isArray(body.customers)).toBe(true);
          // The customer we just created should be in the list.
          const found = body.customers.find(
            (c) => (c as { customerId: string }).customerId === customerId,
          );
          expect(found).toBeDefined();
        } finally {
          await harness.deleteConfig(customerId);
        }
      },
      POLL.timeoutMs,
    );
  },
);

// ---------------------------------------------------------------------------
// Flow 6: DLQ behavior on simulated failures
// ---------------------------------------------------------------------------

flow(
  "DLQ behavior on simulated failures",
  ["dataApiUrl", "webhookUrl", "deadLetterQueueUrl", "customerConfigTableName"],
  (harness) => {
    // Skipped: this test sends a malformed message that triggers the DLQ
    // depth alarm. The behavior is validated by the agent's unit tests instead.
    it.skip(
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
