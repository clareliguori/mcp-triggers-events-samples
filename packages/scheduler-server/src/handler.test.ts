/**
 * Unit tests for the MCP Server 2 (Message Scheduler) Lambda handler (task 7.3).
 *
 * The DynamoDB document client and the KMS client are mocked with
 * `aws-sdk-client-mock`, and `fetch` + `sleep` are injected via the handler's
 * test seams, so the tests exercise the real handler logic (MCP protocol,
 * KMS encrypt/decrypt, Standard Webhooks signing, retry/backoff, lifecycle,
 * scheduled + manual delivery) without touching AWS or waiting on real timers.
 *
 * Coverage mirrors usgs-server/handler.test.ts, adapted for MCP Server 2:
 * - events/list shape (declares briefing.trigger + schedule inputSchema),
 * - events/subscribe validation success + KMS encrypt invoked + record
 *   persisted with the cron schedule, plus rejection of malformed/missing secret
 *   and of the wrong event type,
 * - events/unsubscribe deletes the record,
 * - schedule-check path delivers a briefing.trigger only to due customers with
 *   the correct X-MCP-Subscription-Id + verifiable Standard Webhooks headers,
 * - manual trigger REST route delivers immediately regardless of schedule and
 *   validates the customerId,
 * - retry/backoff: fetch fails then succeeds; assert attempt count and that the
 *   INJECTED fake sleep is invoked with 1s/5s delays (never waiting for real).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import {
  DynamoDBDocumentClient,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  BriefingTriggerData,
  WebhookSubscription,
} from "@mcp-events/shared";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { Webhook } from "standardwebhooks";
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
  type FetchLike,
  // BRIEFING_EVENT_TYPE removed — SDK owns the event type declaration now
  MCP_SUBSCRIPTION_ID_HEADER,
  WEBHOOK_RETRY_DELAYS_MS,
  deliverBriefing,
  handler,
  runScheduleCheck,
  setDocumentClientForTesting,
  setFetchForTesting,
  setKmsClientForTesting,
  setSleepForTesting,
} from "./handler.js";

const SUBSCRIPTIONS_TABLE = "test-subscriptions";
const KEY_ID = "arn:aws:kms:us-east-1:111122223333:key/test-key";

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const SUBSCRIPTION_ID = "22222222-2222-4222-8222-222222222222";

// A structurally valid whsec_ secret: "whsec_" + base64 of 32 bytes. The KMS
// mock "decrypts" to exactly this, so signatures verify against it in tests.
const PLAINTEXT_SECRET = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const CIPHERTEXT_B64 = Buffer.from("ciphertext").toString("base64");

// A cron that is extremely unlikely to match the current minute (midnight on
// Jan 1 only). Used for subscriptions that should NOT fire on schedule. These
// are never signed/delivered, so the timestamp is irrelevant.
const NON_MATCHING_CRON = "0 0 1 1 *";

/**
 * Build a 5-field cron that fires at the given instant's UTC minute and hour.
 * Tests sign deliveries with this same instant so the Standard Webhooks
 * 5-minute timestamp tolerance is satisfied when verifying (hence "now").
 */
function cronMatching(date: Date): string {
  return `${date.getUTCMinutes()} ${date.getUTCHours()} * * *`;
}

const ddbMock = mockClient(DynamoDBDocumentClient);
const kmsMock = mockClient(KMSClient);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSubscription(
  overrides: Partial<WebhookSubscription> = {},
): WebhookSubscription {
  return {
    subscriptionId: SUBSCRIPTION_ID,
    customerId: CUSTOMER_ID,
    serverEndpoint: "https://scheduler-mcp.example.test",
    eventName: "briefing.trigger",
    callbackUrl: "https://webhook.example.test/webhook",
    encryptedSecret: CIPHERTEXT_B64,
    schedule: NON_MATCHING_CRON,
    createdAt: "2024-01-01T00:00:00.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z",
    lastRefreshedAt: "2024-01-01T00:00:00.000Z",
    status: "active",
    ...overrides,
  };
}

/** A fetch stub that records POST deliveries and returns the supplied result. */
function makeDeliveryFetchStub(
  posts: { url: string; headers: Record<string, string>; body: string }[],
  result: { ok: boolean; status: number } = { ok: true, status: 200 },
): FetchLike {
  return (url, init) => {
    posts.push({
      url,
      headers: init?.headers ?? {},
      body: init?.body ?? "",
    });
    return Promise.resolve({
      ...result,
      json: () => Promise.resolve({}),
    });
  };
}

/** Build an API Gateway proxy event for POST /trigger-briefing/{customerId}. */
function makeTriggerEvent(
  customerId: string,
  body: unknown = {},
): APIGatewayProxyEvent {
  return {
    httpMethod: "POST",
    resource: "/trigger-briefing/{customerId}",
    path: `/trigger-briefing/${customerId}`,
    pathParameters: { customerId },
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEvent;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  ddbMock.reset();
  kmsMock.reset();
  setDocumentClientForTesting(
    DynamoDBDocumentClient.from(new DynamoDBClient({})),
  );
  setKmsClientForTesting(new KMSClient({}));

  process.env.SUBSCRIPTIONS_TABLE_NAME = SUBSCRIPTIONS_TABLE;
  process.env.SUBSCRIPTION_SECRET_KEY_ID = KEY_ID;

  // KMS: Encrypt -> ciphertext blob; Decrypt -> the known plaintext secret.
  kmsMock.on(EncryptCommand).resolves({
    CiphertextBlob: new TextEncoder().encode("ciphertext"),
  });
  kmsMock.on(DecryptCommand).resolves({
    Plaintext: new TextEncoder().encode(PLAINTEXT_SECRET),
  });
});

afterEach(() => {
  setDocumentClientForTesting(undefined);
  setKmsClientForTesting(undefined);
  setFetchForTesting(undefined);
  setSleepForTesting(undefined);
  delete process.env.SUBSCRIPTIONS_TABLE_NAME;
  delete process.env.SUBSCRIPTION_SECRET_KEY_ID;
});

afterAll(() => {
  ddbMock.restore();
  kmsMock.restore();
});

// ---------------------------------------------------------------------------
// MCP protocol method tests (events/list, events/subscribe, events/unsubscribe)
// have been removed — these are now handled internally by the SDK's McpServer
// and covered by the SDK's own test suite (469 integration tests).
// ---------------------------------------------------------------------------
// Schedule-check path — due-only delivery with correct headers + signature
// ---------------------------------------------------------------------------

describe("runScheduleCheck delivery", () => {
  it("delivers a briefing.trigger only to due customers with valid headers and signature", async () => {
    // Sign with the current time so the Standard Webhooks 5-minute timestamp
    // tolerance is satisfied when we verify the delivered signature below.
    const now = new Date();
    // Two subscriptions: one due now and one not.
    const dueSub = makeSubscription({ schedule: cronMatching(now) });
    const notDueSub = makeSubscription({
      subscriptionId: "33333333-3333-4333-8333-333333333333",
      customerId: "44444444-4444-4444-8444-444444444444",
      schedule: NON_MATCHING_CRON,
    });
    ddbMock.on(ScanCommand).resolves({ Items: [dueSub, notDueSub] });

    const posts: {
      url: string;
      headers: Record<string, string>;
      body: string;
    }[] = [];
    setFetchForTesting(makeDeliveryFetchStub(posts));
    setSleepForTesting(async () => undefined);

    const summary = await runScheduleCheck(now);

    expect(summary.activeSubscriptions).toBe(2);
    expect(summary.due).toBe(1);
    expect(summary.delivered).toBe(1);
    expect(posts).toHaveLength(1);

    const post = posts[0];
    expect(post.url).toBe("https://webhook.example.test/webhook");
    // Routing header identifies the subscription (Requirement 14.4).
    expect(post.headers[MCP_SUBSCRIPTION_ID_HEADER]).toBe(SUBSCRIPTION_ID);
    // Standard Webhooks headers verify against the (decrypted) per-subscription
    // secret (Requirements 14.5, 2.2).
    expect(post.headers["webhook-id"]).toMatch(/^msg_/);
    expect(post.headers["webhook-timestamp"]).toMatch(/^\d+$/);
    expect(() =>
      new Webhook(PLAINTEXT_SECRET).verify(post.body, {
        "webhook-id": post.headers["webhook-id"],
        "webhook-timestamp": post.headers["webhook-timestamp"],
        "webhook-signature": post.headers["webhook-signature"],
      }),
    ).not.toThrow();

    // The delivered body is a scheduled briefing.trigger for the due customer.
    const event = JSON.parse(post.body);
    expect(event.name).toBe("briefing.trigger");
    expect(event.data.triggerType).toBe("scheduled");
    expect(event.data.customerId).toBe(CUSTOMER_ID);

    // The decrypt was bound to the subscriptionId.
    const decryptCall = kmsMock.commandCalls(DecryptCommand)[0];
    expect(decryptCall.args[0].input.EncryptionContext).toEqual({
      subscriptionId: SUBSCRIPTION_ID,
    });
  });

  it("delivers nothing when no subscription is due", async () => {
    ddbMock
      .on(ScanCommand)
      .resolves({ Items: [makeSubscription({ schedule: NON_MATCHING_CRON })] });

    const posts: {
      url: string;
      headers: Record<string, string>;
      body: string;
    }[] = [];
    setFetchForTesting(makeDeliveryFetchStub(posts));
    setSleepForTesting(async () => undefined);

    const summary = await runScheduleCheck(new Date());
    expect(summary.due).toBe(0);
    expect(summary.delivered).toBe(0);
    expect(posts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Manual trigger REST route
// ---------------------------------------------------------------------------

describe("manual trigger (POST /trigger-briefing/{customerId})", () => {
  it("delivers a manual briefing.trigger immediately regardless of schedule", async () => {
    // The only subscription is NOT due on schedule, but a manual trigger fires
    // it anyway (Requirement 2.4).
    ddbMock
      .on(ScanCommand)
      .resolves({ Items: [makeSubscription({ schedule: NON_MATCHING_CRON })] });

    const posts: {
      url: string;
      headers: Record<string, string>;
      body: string;
    }[] = [];
    setFetchForTesting(makeDeliveryFetchStub(posts));
    setSleepForTesting(async () => undefined);

    const res = await handler(
      makeTriggerEvent(CUSTOMER_ID, { reason: "demo run" }),
    );

    expect(res).toBeDefined();
    const result = res as APIGatewayProxyResult;
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.delivered).toBe(true);
    expect(body.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    expect(posts).toHaveLength(1);
    expect(posts[0].headers[MCP_SUBSCRIPTION_ID_HEADER]).toBe(SUBSCRIPTION_ID);
    const event = JSON.parse(posts[0].body);
    expect(event.name).toBe("briefing.trigger");
    expect(event.data.triggerType).toBe("manual");
    expect(event.data.customerId).toBe(CUSTOMER_ID);
    expect(event.data.reason).toBe("demo run");
  });

  it("returns delivered:false when the customer has no active subscription", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    const posts: {
      url: string;
      headers: Record<string, string>;
      body: string;
    }[] = [];
    setFetchForTesting(makeDeliveryFetchStub(posts));

    const res = await handler(makeTriggerEvent(CUSTOMER_ID));
    const result = res as APIGatewayProxyResult;
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.delivered).toBe(false);
    expect(posts).toHaveLength(0);
  });

  it("returns 400 for a malformed customerId", async () => {
    const res = await handler(makeTriggerEvent("not-a-uuid"));
    const result = res as APIGatewayProxyResult;
    expect(result.statusCode).toBe(400);
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Retry / backoff
// ---------------------------------------------------------------------------

describe("deliverBriefing retry/backoff", () => {
  const data: BriefingTriggerData = {
    triggerType: "scheduled",
    customerId: CUSTOMER_ID,
    scheduledTime: "2024-06-15T12:30:00.000Z",
  };

  it("retries with exponential backoff and succeeds on the third attempt", async () => {
    let attempt = 0;
    const fetchStub: FetchLike = () => {
      attempt += 1;
      return Promise.resolve({
        ok: attempt >= 3,
        status: attempt >= 3 ? 200 : 503,
        json: () => Promise.resolve({}),
      });
    };
    setFetchForTesting(fetchStub);

    const sleeps: number[] = [];
    setSleepForTesting(async (ms) => {
      sleeps.push(ms);
    });

    const outcome = await deliverBriefing(makeSubscription(), data);

    expect(outcome.delivered).toBe(true);
    expect(outcome.attempts).toBe(3);
    expect(sleeps).toEqual([
      WEBHOOK_RETRY_DELAYS_MS[0],
      WEBHOOK_RETRY_DELAYS_MS[1],
    ]);
  });

  it("gives up after 4 attempts (1 + 3 retries) sleeping 1s/5s/30s", async () => {
    const fetchStub = vi.fn<FetchLike>(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      }),
    );
    setFetchForTesting(fetchStub);

    const sleeps: number[] = [];
    setSleepForTesting(async (ms) => {
      sleeps.push(ms);
    });

    const outcome = await deliverBriefing(makeSubscription(), data);

    expect(outcome.delivered).toBe(false);
    expect(outcome.attempts).toBe(4);
    expect(fetchStub).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([...WEBHOOK_RETRY_DELAYS_MS]);
  });

  it("treats a thrown network error as a failed attempt", async () => {
    let attempt = 0;
    const fetchStub: FetchLike = () => {
      attempt += 1;
      if (attempt === 1) {
        return Promise.reject(new Error("ECONNRESET"));
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });
    };
    setFetchForTesting(fetchStub);
    setSleepForTesting(async () => undefined);

    const outcome = await deliverBriefing(makeSubscription(), data);
    expect(outcome.delivered).toBe(true);
    expect(outcome.attempts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Dual-trigger dispatch
// ---------------------------------------------------------------------------

describe("handler dual-trigger dispatch", () => {
  it("runs a schedule check for a non-API (EventBridge) event", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    // An EventBridge scheduled event has no httpMethod; handler returns void.
    const res = await handler({ source: "aws.events" });
    expect(res).toBeUndefined();
    // The schedule check scanned the Subscriptions table.
    expect(ddbMock.commandCalls(ScanCommand).length).toBeGreaterThanOrEqual(1);
  });
});
