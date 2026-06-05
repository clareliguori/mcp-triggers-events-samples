/**
 * Unit tests for the Subscription Manager dual-trigger Lambda handler
 * (task 10.4).
 *
 * The handler only detects the trigger source and dispatches to the real
 * registration (register.ts, task 10.1) or refresh (refresh.ts, task 10.2)
 * logic, so these tests exercise that routing end-to-end against the routed
 * modules' own `setXForTesting` seams — no SigV4 signing, networking, AWS
 * access, or real timers:
 *
 * - the registration path's MCP `events/subscribe`, Data API store, existing-
 *   subscriptions loader, and `sleep` are faked via register.ts seams, and
 * - the refresh path's customer enumeration / MCP subscribe / record upsert /
 *   callback resolution are faked via refresh.ts's {@link RefreshDependencies}.
 *
 * Covered (Requirements 8.1, 8.2, 14.6):
 * - a DynamoDB Stream INSERT event routes to registration (both MCP servers are
 *   subscribed) and the handler returns the registration `{ batchItemFailures }`,
 * - a failed registration surfaces as a batch item failure in the handler's
 *   DynamoDBBatchResponse,
 * - an EventBridge scheduled event routes to refresh (the refresh dependencies
 *   are exercised) and the handler returns no batch response,
 * - the {@link isDynamoDBStreamEvent} trigger-source discriminator.
 */

import type {
  ActiveCustomer,
  RefreshDependencies,
  SubscriptionRecord,
} from "./refresh.js";
import type { CustomerConfig, SubscribeResult } from "@mcp-events/shared";
import type { DynamoDBStreamEvent, EventBridgeEvent } from "aws-lambda";
import { marshall } from "@aws-sdk/util-dynamodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  setExistingSubscriptionsLoaderForTesting,
  setMcpSubscriberForTesting,
  setSleepForTesting,
  setSubscriptionStoreForTesting,
} from "./register.js";
import { setRefreshDependenciesForTesting } from "./refresh.js";
import { handler, isDynamoDBStreamEvent } from "./handler.js";

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const USGS_MCP_URL = "https://usgs-mcp.earthquake-agent.example.com/mcp";
const SCHEDULER_MCP_URL =
  "https://scheduler-mcp.earthquake-agent.example.com/mcp";
const WEBHOOK_URL = "https://webhook.earthquake-agent.example.com";
const DATA_API_URL = "https://api.earthquake-agent.example.com";

// An obviously-fake per-subscription Standard Webhooks secret for fixtures.
// Computed inline from readable plaintext so the decoded value is self-evident
// (it is the literal string below, not a real credential). The base64 body is
// 29 bytes, satisfying the shared whsec_ schema's 24-64 byte requirement.
const PLACEHOLDER_SECRET = `whsec_${Buffer.from(
  "placeholder-not-a-real-secret",
).toString("base64")}`;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<CustomerConfig> = {}): CustomerConfig {
  return {
    customerId: CUSTOMER_ID,
    displayName: "Test Customer",
    subscriptionParams: { minMagnitude: 4.5, region: "pacific" },
    briefingPrompt: "Summarize the day's seismic activity.",
    briefingSchedule: 24,
    active: true,
    createdAt: "2024-02-01T00:00:00.000Z",
    updatedAt: "2024-02-01T00:00:00.000Z",
    ...overrides,
  };
}

function insertStreamEvent(config: CustomerConfig): DynamoDBStreamEvent {
  return {
    Records: [
      {
        eventID: "1",
        eventName: "INSERT",
        eventSource: "aws:dynamodb",
        dynamodb: {
          SequenceNumber: "seq-1",
          NewImage: marshall(config) as never,
        },
      },
    ],
  } as DynamoDBStreamEvent;
}

/** A minimal EventBridge "Scheduled Event" as the 5-min refresh rule delivers. */
function scheduledEvent(): EventBridgeEvent<"Scheduled Event", unknown> {
  return {
    version: "0",
    id: "abcd-1234",
    "detail-type": "Scheduled Event",
    source: "aws.events",
    account: "123456789012",
    time: "2024-02-02T00:00:00Z",
    region: "us-east-1",
    resources: ["arn:aws:events:us-east-1:123456789012:rule/refresh"],
    detail: {},
  };
}

// ---------------------------------------------------------------------------
// Registration-path seams (register.ts)
// ---------------------------------------------------------------------------

let subscribeCalls: { serverUrl: string }[];
let storeCalls: number;

/** Wire the registration seams so a stream-routed registration fully succeeds. */
function wireRegistrationSuccess(): void {
  subscribeCalls = [];
  storeCalls = 0;
  setMcpSubscriberForTesting((serverUrl, params) => {
    subscribeCalls.push({ serverUrl });
    const result: SubscribeResult = {
      subscriptionId:
        params.event === "earthquake.detected"
          ? "22222222-2222-4222-8222-222222222222"
          : "33333333-3333-4333-8333-333333333333",
      expiresAt: "2024-02-02T00:30:00.000Z",
    };
    return Promise.resolve(result);
  });
  setSubscriptionStoreForTesting(() => {
    storeCalls += 1;
    return Promise.resolve({ statusCode: 201, body: "" });
  });
  setExistingSubscriptionsLoaderForTesting(() => Promise.resolve([]));
  setSleepForTesting(() => Promise.resolve());
}

// ---------------------------------------------------------------------------
// Refresh-path seam (refresh.ts)
// ---------------------------------------------------------------------------

let refreshCalls: { customerCount: number }[];

/**
 * Build in-memory {@link RefreshDependencies} that enumerate a single active
 * customer with one expiring subscription, so a refresh-routed invocation
 * exercises the real refresh orchestration and records the subscribe call.
 */
function makeRefreshDependencies(): RefreshDependencies {
  const subscription: SubscriptionRecord = {
    subscriptionId: "44444444-4444-4444-8444-444444444444",
    customerId: CUSTOMER_ID,
    serverEndpoint: USGS_MCP_URL,
    eventName: "earthquake.detected",
    callbackUrl: `${WEBHOOK_URL}/webhook`,
    secret: PLACEHOLDER_SECRET,
    filterParams: { minMagnitude: 4.5, region: "pacific" },
    // Already expired so the refresh always selects it.
    expiresAt: "2024-01-01T00:00:00.000Z",
    createdAt: "2024-01-01T00:00:00.000Z",
    lastRefreshedAt: "2024-01-01T00:00:00.000Z",
    status: "active",
  };
  // The customer already holds a briefing subscription too, so nothing is
  // reported as missing — the run only refreshes the expiring USGS record.
  const briefingSubscription: SubscriptionRecord = {
    ...subscription,
    subscriptionId: "55555555-5555-4555-8555-555555555555",
    serverEndpoint: SCHEDULER_MCP_URL,
    eventName: "briefing.trigger",
    schedule: 24,
    filterParams: undefined,
    expiresAt: "2999-01-01T00:00:00.000Z",
  };

  const customer: ActiveCustomer = {
    config: makeConfig(),
    subscriptions: [subscription, briefingSubscription],
  };

  return {
    listActiveCustomers: () => {
      refreshCalls.push({ customerCount: 1 });
      return Promise.resolve([customer]);
    },
    subscribeOnServer: () =>
      Promise.resolve({
        subscriptionId: subscription.subscriptionId,
        expiresAt: "2024-02-02T00:30:00.000Z",
      }),
    upsertSubscriptionRecord: () => Promise.resolve(),
    resolveCallbackUrl: () => `${WEBHOOK_URL}/webhook`,
  };
}

beforeEach(() => {
  refreshCalls = [];
  process.env.DATA_API_URL = DATA_API_URL;
  process.env.USGS_MCP_URL = USGS_MCP_URL;
  process.env.SCHEDULER_MCP_URL = SCHEDULER_MCP_URL;
  process.env.WEBHOOK_URL = WEBHOOK_URL;
});

afterEach(() => {
  setMcpSubscriberForTesting(undefined);
  setSubscriptionStoreForTesting(undefined);
  setExistingSubscriptionsLoaderForTesting(undefined);
  setSleepForTesting(undefined);
  setRefreshDependenciesForTesting(undefined);
  delete process.env.DATA_API_URL;
  delete process.env.USGS_MCP_URL;
  delete process.env.SCHEDULER_MCP_URL;
  delete process.env.WEBHOOK_URL;
});

// ---------------------------------------------------------------------------
// isDynamoDBStreamEvent — trigger-source detection
// ---------------------------------------------------------------------------

describe("isDynamoDBStreamEvent", () => {
  it("recognizes a DynamoDB Stream event (Records with aws:dynamodb source)", () => {
    expect(isDynamoDBStreamEvent(insertStreamEvent(makeConfig()))).toBe(true);
  });

  it("recognizes an empty-Records stream invocation", () => {
    expect(isDynamoDBStreamEvent({ Records: [] })).toBe(true);
  });

  it("recognizes a stream record by its dynamodb field alone", () => {
    expect(
      isDynamoDBStreamEvent({
        Records: [{ dynamodb: { SequenceNumber: "x" } }],
      }),
    ).toBe(true);
  });

  it("rejects an EventBridge scheduled event", () => {
    expect(isDynamoDBStreamEvent(scheduledEvent())).toBe(false);
  });

  it("rejects a non-DynamoDB Records event (e.g. SQS)", () => {
    expect(
      isDynamoDBStreamEvent({
        Records: [{ eventSource: "aws:sqs", messageId: "m1" }],
      }),
    ).toBe(false);
  });

  it("rejects non-object / null inputs", () => {
    expect(isDynamoDBStreamEvent(null)).toBe(false);
    expect(isDynamoDBStreamEvent(undefined)).toBe(false);
    expect(isDynamoDBStreamEvent("Scheduled Event")).toBe(false);
    expect(isDynamoDBStreamEvent({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handler — DynamoDB Stream trigger routes to registration
// ---------------------------------------------------------------------------

describe("handler (DynamoDB Stream trigger)", () => {
  it("routes a stream INSERT to registration and returns its batch response", async () => {
    wireRegistrationSuccess();

    const result = await handler(insertStreamEvent(makeConfig()));

    // Registration ran: both MCP servers subscribed, both records stored.
    expect(subscribeCalls).toHaveLength(2);
    expect(storeCalls).toBe(2);

    // The handler returned the registration { batchItemFailures } unchanged.
    expect(result).toEqual({ batchItemFailures: [] });
    // Refresh was NOT invoked.
    expect(refreshCalls).toHaveLength(0);
  });

  it("surfaces a failed registration as a batch item failure", async () => {
    wireRegistrationSuccess();
    // Make every subscribe fail so the record is reported for redrive.
    setMcpSubscriberForTesting(() =>
      Promise.reject(new Error("server unavailable")),
    );

    const result = await handler(insertStreamEvent(makeConfig()));

    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: "seq-1" }],
    });
  });

  it("processes a MODIFY stream record as a registration", async () => {
    wireRegistrationSuccess();
    const modifyEvent = {
      Records: [
        {
          eventID: "1",
          eventName: "MODIFY",
          eventSource: "aws:dynamodb",
          dynamodb: {
            SequenceNumber: "seq-2",
            NewImage: marshall(makeConfig()) as never,
          },
        },
      ],
    } as DynamoDBStreamEvent;

    const result = await handler(modifyEvent);

    expect(result).toEqual({ batchItemFailures: [] });
    expect(subscribeCalls).toHaveLength(2); // one per MCP server
  });
});

// ---------------------------------------------------------------------------
// handler — EventBridge scheduled trigger routes to refresh
// ---------------------------------------------------------------------------

describe("handler (EventBridge scheduled trigger)", () => {
  it("routes a scheduled event to refresh and returns no batch response", async () => {
    wireRegistrationSuccess();
    setRefreshDependenciesForTesting(makeRefreshDependencies());

    const result = await handler(scheduledEvent());

    // Refresh ran: it enumerated the active customers.
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0].customerCount).toBe(1);
    // Registration was NOT invoked.
    expect(subscribeCalls).toHaveLength(0);
    expect(storeCalls).toBe(0);
    // The refresh path has no per-record result to report.
    expect(result).toBeUndefined();
  });
});
