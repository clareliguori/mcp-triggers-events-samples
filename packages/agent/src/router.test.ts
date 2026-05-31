/**
 * Unit tests for the Serverless Agent event router (task 9.3).
 *
 * The Data API subscription lookup is replaced with a mock
 * {@link SubscriptionLookup} via {@link setSubscriptionLookupForTesting}, and
 * the SQS client (used for explicit dead-lettering) is mocked with
 * `aws-sdk-client-mock`, so these tests exercise the real router logic
 * (subscriptionId extraction from message attributes, event payload
 * validation, customer resolution, event-type determination, and DLQ routing
 * for a missing subscription-to-customer mapping) without SigV4 signing or
 * network/AWS access.
 *
 * Covered (Requirements 4.1, 15.6):
 * - routes an `earthquake.detected` event to its customer,
 * - routes a `briefing.trigger` event to its customer,
 * - dead-letters a record whose subscription is unknown (Data API 404),
 * - dead-letters a record missing the subscriptionId message attribute,
 * - dead-letters a record whose body is not a valid MCP event,
 * - throws (for SQS retry) on a transient Data API failure.
 */

import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { SQSRecord } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  DLQ_REASON_ATTRIBUTE,
  SUBSCRIPTION_ID_ATTRIBUTE,
  resolveCustomerId,
  routeRecord,
  setSqsClientForTesting,
  setSubscriptionLookupForTesting,
  type SubscriptionLookupResult,
} from "./router.js";

const DATA_API_URL = "https://api.earthquake-agent.example.com";
const DLQ_URL =
  "https://sqs.us-east-1.amazonaws.com/123456789012/earthquake-agent-events-dlq";

const SUBSCRIPTION_ID = "22222222-2222-4222-8222-222222222222";
const CUSTOMER_ID = "33333333-3333-4333-8333-333333333333";
const EARTHQUAKE_EVENT_ID = "11111111-1111-4111-8111-111111111111";
const BRIEFING_EVENT_ID = "44444444-4444-4444-8444-444444444444";

/** A valid `earthquake.detected` MCP event payload (matches the shared schema). */
const EARTHQUAKE_EVENT = {
  eventId: EARTHQUAKE_EVENT_ID,
  name: "earthquake.detected",
  timestamp: "2024-01-01T00:00:00.000Z",
  data: {
    earthquakeId: "us7000n123",
    magnitude: 5.2,
    place: "10km SW of Ridgecrest, CA",
    coordinates: { longitude: -117.5, latitude: 35.6, depth: 8.2 },
    time: "2024-01-01T00:00:00.000Z",
    tsunami: false,
    felt: 12,
    alert: "green",
    url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000n123",
  },
  cursor: "cursor-1",
};

/** A valid `briefing.trigger` MCP event payload (matches the shared schema). */
const BRIEFING_EVENT = {
  eventId: BRIEFING_EVENT_ID,
  name: "briefing.trigger",
  timestamp: "2024-01-01T01:00:00.000Z",
  data: {
    triggerType: "scheduled",
    customerId: CUSTOMER_ID,
    scheduledTime: "2024-01-01T01:00:00.000Z",
  },
  cursor: "cursor-2",
};

const sqsMock = mockClient(SQSClient);

/** Build a Data API lookup that returns the given customerId (200). */
function lookupReturningCustomer(customerId: string) {
  return vi.fn(
    async (_id: string): Promise<SubscriptionLookupResult> => ({
      statusCode: 200,
      body: JSON.stringify({
        subscriptionId: SUBSCRIPTION_ID,
        customerId,
        secret: "whsec_xxxx",
      }),
    }),
  );
}

/** Build an SQS record with the given body and (optional) subscription id attribute. */
function makeRecord(opts: {
  body: string;
  subscriptionId?: string;
  messageId?: string;
}): SQSRecord {
  const messageAttributes: SQSRecord["messageAttributes"] = {};
  if (opts.subscriptionId !== undefined) {
    messageAttributes[SUBSCRIPTION_ID_ATTRIBUTE] = {
      stringValue: opts.subscriptionId,
      dataType: "String",
      stringListValues: [],
      binaryListValues: [],
    };
  }
  return {
    messageId: opts.messageId ?? "msg-1",
    receiptHandle: "rh-1",
    body: opts.body,
    attributes: {} as SQSRecord["attributes"],
    messageAttributes,
    md5OfBody: "",
    eventSource: "aws:sqs",
    eventSourceARN:
      "arn:aws:sqs:us-east-1:123456789012:earthquake-agent-events",
    awsRegion: "us-east-1",
  };
}

beforeEach(() => {
  sqsMock.reset();
  setSqsClientForTesting(sqsMock as unknown as SQSClient);
  process.env.DATA_API_URL = DATA_API_URL;
  process.env.DEAD_LETTER_QUEUE_URL = DLQ_URL;
});

afterEach(() => {
  setSubscriptionLookupForTesting(undefined);
  setSqsClientForTesting(undefined);
  delete process.env.DATA_API_URL;
  delete process.env.DEAD_LETTER_QUEUE_URL;
});

afterAll(() => {
  sqsMock.restore();
});

describe("routeRecord", () => {
  it("routes an earthquake.detected event to its resolved customer", async () => {
    const lookup = lookupReturningCustomer(CUSTOMER_ID);
    setSubscriptionLookupForTesting(lookup);

    const outcome = await routeRecord(
      makeRecord({
        body: JSON.stringify(EARTHQUAKE_EVENT),
        subscriptionId: SUBSCRIPTION_ID,
      }),
    );

    expect(lookup).toHaveBeenCalledWith(SUBSCRIPTION_ID);
    expect(outcome.status).toBe("routed");
    if (outcome.status !== "routed") {
      throw new Error("expected routed outcome");
    }
    expect(outcome.event).toMatchObject({
      subscriptionId: SUBSCRIPTION_ID,
      customerId: CUSTOMER_ID,
      eventType: "earthquake.detected",
    });
    expect(outcome.event.event.eventId).toBe(EARTHQUAKE_EVENT_ID);
    // No dead-lettering on the happy path.
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("routes a briefing.trigger event and determines its event type", async () => {
    setSubscriptionLookupForTesting(lookupReturningCustomer(CUSTOMER_ID));

    const outcome = await routeRecord(
      makeRecord({
        body: JSON.stringify(BRIEFING_EVENT),
        subscriptionId: SUBSCRIPTION_ID,
      }),
    );

    expect(outcome.status).toBe("routed");
    if (outcome.status !== "routed") {
      throw new Error("expected routed outcome");
    }
    expect(outcome.event.eventType).toBe("briefing.trigger");
    expect(outcome.event.customerId).toBe(CUSTOMER_ID);
  });

  it("dead-letters a record whose subscription is unknown (Data API 404)", async () => {
    const lookup = vi.fn(
      async (_id: string): Promise<SubscriptionLookupResult> => ({
        statusCode: 404,
        body: JSON.stringify({ error: "Not Found" }),
      }),
    );
    setSubscriptionLookupForTesting(lookup);
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "dlq-1" });

    const outcome = await routeRecord(
      makeRecord({
        body: JSON.stringify(EARTHQUAKE_EVENT),
        subscriptionId: SUBSCRIPTION_ID,
      }),
    );

    expect(outcome.status).toBe("dead-lettered");

    const calls = sqsMock.commandCalls(SendMessageCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input.QueueUrl).toBe(DLQ_URL);
    expect(input.MessageBody).toBe(JSON.stringify(EARTHQUAKE_EVENT));
    // The subscription id and a dlqReason are preserved for investigation.
    expect(input.MessageAttributes?.[SUBSCRIPTION_ID_ATTRIBUTE]).toEqual({
      DataType: "String",
      StringValue: SUBSCRIPTION_ID,
    });
    expect(
      input.MessageAttributes?.[DLQ_REASON_ATTRIBUTE]?.StringValue,
    ).toContain(SUBSCRIPTION_ID);
  });

  it("dead-letters a record missing the subscriptionId message attribute", async () => {
    const lookup = lookupReturningCustomer(CUSTOMER_ID);
    setSubscriptionLookupForTesting(lookup);
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "dlq-2" });

    const outcome = await routeRecord(
      makeRecord({ body: JSON.stringify(EARTHQUAKE_EVENT) }),
    );

    expect(outcome.status).toBe("dead-lettered");
    // The subscription could not be resolved, so the Data API is never called.
    expect(lookup).not.toHaveBeenCalled();
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
  });

  it("dead-letters a record whose body is not a valid MCP event", async () => {
    const lookup = lookupReturningCustomer(CUSTOMER_ID);
    setSubscriptionLookupForTesting(lookup);
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "dlq-3" });

    const outcome = await routeRecord(
      makeRecord({
        body: JSON.stringify({ not: "an event" }),
        subscriptionId: SUBSCRIPTION_ID,
      }),
    );

    expect(outcome.status).toBe("dead-lettered");
    expect(lookup).not.toHaveBeenCalled();
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
  });

  it("dead-letters a record whose body is not valid JSON", async () => {
    setSubscriptionLookupForTesting(lookupReturningCustomer(CUSTOMER_ID));
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "dlq-4" });

    const outcome = await routeRecord(
      makeRecord({ body: "{not json", subscriptionId: SUBSCRIPTION_ID }),
    );

    expect(outcome.status).toBe("dead-lettered");
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
  });

  it("throws (for SQS retry) on a transient Data API failure and does not dead-letter", async () => {
    const lookup = vi.fn(
      async (_id: string): Promise<SubscriptionLookupResult> => ({
        statusCode: 503,
        body: "unavailable",
      }),
    );
    setSubscriptionLookupForTesting(lookup);

    await expect(
      routeRecord(
        makeRecord({
          body: JSON.stringify(EARTHQUAKE_EVENT),
          subscriptionId: SUBSCRIPTION_ID,
        }),
      ),
    ).rejects.toThrow(/503/);

    // Transient failures must not be dead-lettered — let SQS retry.
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });
});

describe("resolveCustomerId", () => {
  it("returns the customerId from a 200 lookup", async () => {
    setSubscriptionLookupForTesting(lookupReturningCustomer(CUSTOMER_ID));
    await expect(resolveCustomerId(SUBSCRIPTION_ID)).resolves.toBe(CUSTOMER_ID);
  });

  it("throws SubscriptionNotFoundError on a 404", async () => {
    setSubscriptionLookupForTesting(
      vi.fn(
        async (): Promise<SubscriptionLookupResult> => ({
          statusCode: 404,
          body: "",
        }),
      ),
    );
    await expect(resolveCustomerId(SUBSCRIPTION_ID)).rejects.toMatchObject({
      name: "SubscriptionNotFoundError",
      subscriptionId: SUBSCRIPTION_ID,
    });
  });

  it("throws on a 200 body that has no customerId (treated as transient)", async () => {
    setSubscriptionLookupForTesting(
      vi.fn(
        async (): Promise<SubscriptionLookupResult> => ({
          statusCode: 200,
          body: JSON.stringify({ subscriptionId: SUBSCRIPTION_ID }),
        }),
      ),
    );
    await expect(resolveCustomerId(SUBSCRIPTION_ID)).rejects.toThrow(
      /no customerId/,
    );
  });
});
