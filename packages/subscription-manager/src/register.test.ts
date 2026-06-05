/**
 * Unit tests for the Subscription Manager customer registration logic
 * (task 10.1).
 *
 * Every side effect is replaced via the module's `setXForTesting` seams — the
 * MCP `events/subscribe` call, the Data API subscription store, the Data API
 * existing-subscriptions loader, and `sleep` — so these tests exercise the real
 * registration logic (DynamoDB Stream parsing, per-subscription `whsec_` secret
 * generation, target construction, partial-failure retry, idempotency) without
 * SigV4 signing, networking, AWS access, or real timers.
 *
 * Covered (Requirements 8.1, 8.3, 14.6):
 * - registers a new customer on BOTH MCP servers with the right event names,
 *   filter params / schedule, a freshly generated per-subscription `whsec_`
 *   secret in delivery.secret, and stores the records (with plaintext secret)
 *   via the Data API,
 * - the two servers get DIFFERENT generated secrets,
 * - partial failure: when MCP Server 2's subscribe fails, Server 1 is still
 *   created and the failure is retried (then surfaced) without re-doing Server
 *   1,
 * - a transient Data API store failure is retried then succeeds,
 * - idempotency: a customer that already has active subscriptions is skipped,
 * - stream parsing: non-INSERT, missing image, invalid, and inactive records
 *   are ignored; a valid INSERT is registered; a failed registration is
 *   reported as a batch item failure.
 */

import type { CustomerConfig, SubscribeResult } from "@mcp-events/shared";
import { whsecSecretSchema } from "@mcp-events/shared";
import type { DynamoDBStreamEvent } from "aws-lambda";
import { marshall } from "@aws-sdk/util-dynamodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type DataApiResult,
  type ExistingSubscription,
  type McpSubscribeParams,
  type SubscriptionCreateBody,
  handleRegistrationStream,
  parseNewCustomer,
  registerCustomer,
  setExistingSubscriptionsLoaderForTesting,
  setMcpSubscriberForTesting,
  setSleepForTesting,
  setSubscriptionStoreForTesting,
} from "./register.js";

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const USGS_MCP_URL = "https://usgs-mcp.earthquake-agent.example.com/mcp";
const SCHEDULER_MCP_URL =
  "https://scheduler-mcp.earthquake-agent.example.com/mcp";
const WEBHOOK_URL = "https://webhook.earthquake-agent.example.com";
const DATA_API_URL = "https://api.earthquake-agent.example.com";

const NOW = new Date("2024-02-02T00:00:00.000Z");

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

/** Record subscribe calls + the params they were issued with. */
interface SubscribeCall {
  serverUrl: string;
  params: McpSubscribeParams;
}

/** Record store calls + the bodies they were issued with. */
interface StoreCall {
  customerId: string;
  body: SubscriptionCreateBody;
}

let subscribeCalls: SubscribeCall[];
let storeCalls: StoreCall[];
let sleeps: number[];

beforeEach(() => {
  subscribeCalls = [];
  storeCalls = [];
  sleeps = [];

  process.env.DATA_API_URL = DATA_API_URL;
  process.env.USGS_MCP_URL = USGS_MCP_URL;
  process.env.SCHEDULER_MCP_URL = SCHEDULER_MCP_URL;
  process.env.WEBHOOK_URL = WEBHOOK_URL;

  // Default seams: every subscribe succeeds with a deterministic id derived
  // from the event, every store returns 201, no existing subscriptions, and
  // sleep is a no-op recorder so retries never wait on real timers.
  setMcpSubscriberForTesting((serverUrl, params) => {
    subscribeCalls.push({ serverUrl, params });
    const result: SubscribeResult = {
      subscriptionId:
        params.event === "earthquake.detected"
          ? "22222222-2222-4222-8222-222222222222"
          : "33333333-3333-4333-8333-333333333333",
      expiresAt: "2024-02-02T00:30:00.000Z",
    };
    return Promise.resolve(result);
  });
  setSubscriptionStoreForTesting((customerId, body) => {
    storeCalls.push({ customerId, body });
    const result: DataApiResult = { statusCode: 201, body: "" };
    return Promise.resolve(result);
  });
  setExistingSubscriptionsLoaderForTesting(() => Promise.resolve([]));
  setSleepForTesting(async (ms) => {
    sleeps.push(ms);
  });
});

afterEach(() => {
  setMcpSubscriberForTesting(undefined);
  setSubscriptionStoreForTesting(undefined);
  setExistingSubscriptionsLoaderForTesting(undefined);
  setSleepForTesting(undefined);
  delete process.env.DATA_API_URL;
  delete process.env.USGS_MCP_URL;
  delete process.env.SCHEDULER_MCP_URL;
  delete process.env.WEBHOOK_URL;
});

// ---------------------------------------------------------------------------
// registerCustomer — happy path
// ---------------------------------------------------------------------------

describe("registerCustomer", () => {
  it("subscribes on both MCP servers with the right params and stores both records", async () => {
    const result = await registerCustomer(makeConfig(), NOW);

    expect(result.success).toBe(true);
    expect(result.customerId).toBe(CUSTOMER_ID);
    expect(result.outcomes.map((o) => o.status)).toEqual([
      "created",
      "created",
    ]);

    // Both servers were subscribed, in order: USGS then Scheduler.
    expect(subscribeCalls).toHaveLength(2);
    const [usgs, scheduler] = subscribeCalls;

    expect(usgs.serverUrl).toBe(USGS_MCP_URL);
    expect(usgs.params.event).toBe("earthquake.detected");
    expect(usgs.params.customerId).toBe(CUSTOMER_ID);
    expect(usgs.params.delivery.url).toBe(`${WEBHOOK_URL}/webhook`);
    expect(usgs.params.inputSchema).toEqual({
      minMagnitude: 4.5,
      region: "pacific",
    });
    // The supplied secret is a valid, freshly generated whsec_ value.
    expect(
      whsecSecretSchema.safeParse(usgs.params.delivery.secret).success,
    ).toBe(true);

    expect(scheduler.serverUrl).toBe(SCHEDULER_MCP_URL);
    expect(scheduler.params.event).toBe("briefing.trigger");
    expect(scheduler.params.inputSchema).toEqual({ intervalHours: 24 });
    expect(
      whsecSecretSchema.safeParse(scheduler.params.delivery.secret).success,
    ).toBe(true);

    // Both records were stored with the PLAINTEXT secret (the Data API encrypts
    // at its storage boundary) and the server-returned subscriptionId/expiresAt.
    expect(storeCalls).toHaveLength(2);
    const usgsStore = storeCalls.find(
      (c) => c.body.eventName === "earthquake.detected",
    )!;
    expect(usgsStore.customerId).toBe(CUSTOMER_ID);
    expect(usgsStore.body.subscriptionId).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
    expect(usgsStore.body.serverEndpoint).toBe(USGS_MCP_URL);
    expect(usgsStore.body.callbackUrl).toBe(`${WEBHOOK_URL}/webhook`);
    expect(usgsStore.body.filterParams).toEqual({
      minMagnitude: 4.5,
      region: "pacific",
    });
    expect(usgsStore.body.status).toBe("active");
    expect(usgsStore.body.expiresAt).toBe("2024-02-02T00:30:00.000Z");
    expect(usgsStore.body.createdAt).toBe(NOW.toISOString());
    // The stored body carries plaintext secret, never encryptedSecret.
    expect(usgsStore.body).toHaveProperty("secret");
    expect(usgsStore.body).not.toHaveProperty("encryptedSecret");
    expect(usgsStore.body.secret).toBe(usgs.params.delivery.secret);

    const schedulerStore = storeCalls.find(
      (c) => c.body.eventName === "briefing.trigger",
    )!;
    expect(schedulerStore.body.schedule).toBe(24);
    expect(schedulerStore.body.secret).toBe(scheduler.params.delivery.secret);
  });

  it("generates a distinct per-subscription secret for each server", async () => {
    await registerCustomer(makeConfig(), NOW);

    const [usgs, scheduler] = subscribeCalls;
    expect(usgs.params.delivery.secret).not.toBe(
      scheduler.params.delivery.secret,
    );
  });

  it("omits unset filter params from the USGS inputSchema (deliver-all)", async () => {
    await registerCustomer(makeConfig({ subscriptionParams: {} }), NOW);

    const usgs = subscribeCalls.find(
      (c) => c.params.event === "earthquake.detected",
    )!;
    expect(usgs.params.inputSchema).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Partial failure + retry
// ---------------------------------------------------------------------------

describe("registerCustomer partial failure", () => {
  it("creates Server 1 but reports Server 2 failed after retries, without re-doing Server 1", async () => {
    setMcpSubscriberForTesting((serverUrl, params) => {
      subscribeCalls.push({ serverUrl, params });
      if (params.event === "briefing.trigger") {
        return Promise.reject(new Error("scheduler unavailable"));
      }
      return Promise.resolve({
        subscriptionId: "22222222-2222-4222-8222-222222222222",
        expiresAt: "2024-02-02T00:30:00.000Z",
      });
    });

    const result = await registerCustomer(makeConfig(), NOW);

    expect(result.success).toBe(false);
    const usgsOutcome = result.outcomes.find((o) => o.server === "usgs")!;
    const schedulerOutcome = result.outcomes.find(
      (o) => o.server === "scheduler",
    )!;
    expect(usgsOutcome.status).toBe("created");
    expect(schedulerOutcome.status).toBe("failed");
    expect(schedulerOutcome.error).toMatch(/scheduler unavailable/);

    // USGS subscribed exactly once (not re-done); scheduler subscribe was
    // attempted 3 times (1 + 2 retries) with 1s/5s backoff.
    const usgsAttempts = subscribeCalls.filter(
      (c) => c.params.event === "earthquake.detected",
    );
    const schedulerAttempts = subscribeCalls.filter(
      (c) => c.params.event === "briefing.trigger",
    );
    expect(usgsAttempts).toHaveLength(1);
    expect(schedulerAttempts).toHaveLength(3);
    expect(sleeps).toEqual([1000, 5000]);

    // Only the USGS record was stored.
    expect(storeCalls).toHaveLength(1);
    expect(storeCalls[0].body.eventName).toBe("earthquake.detected");
  });

  it("retries a transient Data API store failure then succeeds", async () => {
    let usgsStoreAttempts = 0;
    setSubscriptionStoreForTesting((customerId, body) => {
      storeCalls.push({ customerId, body });
      if (body.eventName === "earthquake.detected") {
        usgsStoreAttempts += 1;
        if (usgsStoreAttempts === 1) {
          return Promise.resolve({ statusCode: 500, body: "boom" });
        }
      }
      return Promise.resolve({ statusCode: 201, body: "" });
    });

    const result = await registerCustomer(makeConfig(), NOW);

    expect(result.success).toBe(true);
    // The USGS subscribe happened once; the store was retried (2 attempts).
    const usgsSubscribes = subscribeCalls.filter(
      (c) => c.params.event === "earthquake.detected",
    );
    expect(usgsSubscribes).toHaveLength(1);
    expect(usgsStoreAttempts).toBe(2);
    // Both stores carried the SAME subscriptionId across the retry (no orphan).
    const usgsStores = storeCalls.filter(
      (c) => c.body.eventName === "earthquake.detected",
    );
    expect(usgsStores).toHaveLength(2);
    expect(usgsStores[0].body.subscriptionId).toBe(
      usgsStores[1].body.subscriptionId,
    );
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("registerCustomer idempotency", () => {
  it("skips a server that already has an active subscription", async () => {
    const existing: ExistingSubscription[] = [
      { eventName: "earthquake.detected", status: "active" },
    ];
    setExistingSubscriptionsLoaderForTesting(() => Promise.resolve(existing));

    const result = await registerCustomer(makeConfig(), NOW);

    expect(result.success).toBe(true);
    const usgsOutcome = result.outcomes.find((o) => o.server === "usgs")!;
    const schedulerOutcome = result.outcomes.find(
      (o) => o.server === "scheduler",
    )!;
    expect(usgsOutcome.status).toBe("skipped-existing");
    expect(schedulerOutcome.status).toBe("created");

    // Only the scheduler was subscribed/stored.
    expect(subscribeCalls).toHaveLength(1);
    expect(subscribeCalls[0].params.event).toBe("briefing.trigger");
    expect(storeCalls).toHaveLength(1);
  });

  it("still creates when the existing-subscriptions read fails", async () => {
    setExistingSubscriptionsLoaderForTesting(() =>
      Promise.reject(new Error("data api down")),
    );

    const result = await registerCustomer(makeConfig(), NOW);

    expect(result.success).toBe(true);
    expect(subscribeCalls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// parseNewCustomer
// ---------------------------------------------------------------------------

describe("parseNewCustomer", () => {
  function streamRecord(
    config: CustomerConfig,
    eventName: "INSERT" | "MODIFY" | "REMOVE" = "INSERT",
  ): DynamoDBStreamEvent["Records"][number] {
    return {
      eventName,
      dynamodb: {
        SequenceNumber: "seq-1",
        NewImage: marshall(config) as never,
      },
    } as DynamoDBStreamEvent["Records"][number];
  }

  it("parses a valid active INSERT into a CustomerConfig", () => {
    const config = makeConfig();
    const parsed = parseNewCustomer(streamRecord(config));
    expect(parsed).toEqual(config);
  });

  it("ignores non-INSERT events", () => {
    expect(
      parseNewCustomer(streamRecord(makeConfig(), "MODIFY")),
    ).toBeUndefined();
  });

  it("ignores a record with no NewImage", () => {
    const record = {
      eventName: "INSERT",
      dynamodb: { SequenceNumber: "seq-1" },
    } as DynamoDBStreamEvent["Records"][number];
    expect(parseNewCustomer(record)).toBeUndefined();
  });

  it("ignores an inactive (soft-deleted) customer image", () => {
    expect(
      parseNewCustomer(streamRecord(makeConfig({ active: false }))),
    ).toBeUndefined();
  });

  it("ignores a structurally invalid image", () => {
    const record = {
      eventName: "INSERT",
      dynamodb: {
        SequenceNumber: "seq-1",
        NewImage: marshall({ customerId: "not-a-uuid" }) as never,
      },
    } as DynamoDBStreamEvent["Records"][number];
    expect(parseNewCustomer(record)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// handleRegistrationStream
// ---------------------------------------------------------------------------

describe("handleRegistrationStream", () => {
  function insertEvent(config: CustomerConfig): DynamoDBStreamEvent {
    return {
      Records: [
        {
          eventName: "INSERT",
          dynamodb: {
            SequenceNumber: "seq-1",
            NewImage: marshall(config) as never,
          },
        },
      ],
    } as DynamoDBStreamEvent;
  }

  it("registers a new customer and reports no batch item failures on success", async () => {
    const result = await handleRegistrationStream(
      insertEvent(makeConfig()),
      NOW,
    );
    expect(result.batchItemFailures).toEqual([]);
    expect(subscribeCalls).toHaveLength(2);
  });

  it("reports a batch item failure when registration fails", async () => {
    setMcpSubscriberForTesting(() =>
      Promise.reject(new Error("server unavailable")),
    );

    const result = await handleRegistrationStream(
      insertEvent(makeConfig()),
      NOW,
    );
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "seq-1" }]);
  });

  it("ignores non-applicable records without failing the batch", async () => {
    const event = {
      Records: [
        {
          eventName: "MODIFY",
          dynamodb: {
            SequenceNumber: "seq-2",
            NewImage: marshall(makeConfig()) as never,
          },
        },
      ],
    } as DynamoDBStreamEvent;

    const result = await handleRegistrationStream(event, NOW);
    expect(result.batchItemFailures).toEqual([]);
    expect(subscribeCalls).toHaveLength(0);
  });
});
