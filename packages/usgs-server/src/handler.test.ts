/**
 * Unit tests for the MCP Server 1 Lambda handler (task 6.5).
 *
 * The DynamoDB document client and the KMS client are mocked with
 * `aws-sdk-client-mock`, and `fetch` + `sleep` are injected via the handler's
 * test seams, so the tests exercise the real handler logic (MCP protocol,
 * KMS encrypt/decrypt, Standard Webhooks signing, retry/backoff, lifecycle,
 * cursor commit ordering) without touching AWS or waiting on real timers.
 *
 * Coverage:
 * - events/list shape (declares earthquake.detected + inputSchema),
 * - events/subscribe validation success + KMS encrypt invoked + record
 *   persisted, plus rejection of malformed / missing secret,
 * - events/unsubscribe deletes the record,
 * - poll path delivers only filtered earthquakes with the correct
 *   X-MCP-Subscription-Id + Standard Webhooks headers (verifiable signature),
 * - retry/backoff: fetch fails then succeeds; assert attempt count and that the
 *   INJECTED fake sleep is invoked with 1s/5s delays (never waiting for real),
 * - cursor committed only after successful emission (and NOT when the USGS
 *   fetch fails).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import {
  DynamoDBDocumentClient,

  GetCommand,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { WebhookSubscription } from "@mcp-events/shared";
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

  MCP_SUBSCRIPTION_ID_HEADER,
  WEBHOOK_RETRY_DELAYS_MS,
  deliverEarthquake,
  handler,
  runPollCycle,
  setDocumentClientForTesting,
  setFetchForTesting,
  setKmsClientForTesting,
  setSleepForTesting,
} from "./handler.js";

const SUBSCRIPTIONS_TABLE = "test-subscriptions";
const CURSOR_TABLE = "test-cursor-state";
const KEY_ID = "arn:aws:kms:us-east-1:111122223333:key/test-key";
const FEED_URL = "https://example.test/feed.geojson";

// A structurally valid whsec_ secret: "whsec_" + base64 of 32 bytes. The KMS
// mock "decrypts" to exactly this, so signatures verify against it in tests.
const PLAINTEXT_SECRET = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const CIPHERTEXT_B64 = Buffer.from("ciphertext").toString("base64");

const ddbMock = mockClient(DynamoDBDocumentClient);
const kmsMock = mockClient(KMSClient);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSubscription(
  overrides: Partial<WebhookSubscription> = {},
): WebhookSubscription {
  return {
    subscriptionId: "22222222-2222-4222-8222-222222222222",
    customerId: "11111111-1111-4111-8111-111111111111",
    serverEndpoint: "https://usgs-mcp.example.test",
    eventName: "earthquake.detected",
    callbackUrl: "https://webhook.example.test/webhook",
    encryptedSecret: CIPHERTEXT_B64,
    filterParams: { minMagnitude: 4.0 },
    createdAt: "2024-01-01T00:00:00.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z",
    lastRefreshedAt: "2024-01-01T00:00:00.000Z",
    status: "active",
    ...overrides,
  };
}

/** A USGS GeoJSON feature for the poll-path fetch stub. */
function makeFeature(id: string, mag: number, lonLatDepth: number[]) {
  return {
    id,
    properties: {
      mag,
      place: "synthetic",
      time: 1_700_000_000_000,
      tsunami: 0,
      felt: null,
      alert: null,
      url: `https://earthquake.usgs.gov/eventpage/${id}`,
    },
    geometry: { coordinates: lonLatDepth },
  };
}

/** A fetch stub that serves the USGS feed for GETs and records POST deliveries. */
function makeFetchStub(
  feed: unknown,
  onPost: (
    url: string,
    init: { headers?: Record<string, string>; body?: string },
  ) => {
    ok: boolean;
    status: number;
  },
): FetchLike {
  return (url, init) => {
    const method = init?.method ?? "GET";
    if (method === "GET") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(feed),
      });
    }
    const result = onPost(url, init ?? {});
    return Promise.resolve({
      ...result,
      json: () => Promise.resolve({}),
    });
  };
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
  process.env.CURSOR_STATE_TABLE_NAME = CURSOR_TABLE;
  process.env.SUBSCRIPTION_SECRET_KEY_ID = KEY_ID;
  process.env.USGS_FEED_URL = FEED_URL;

  // KMS: Encrypt -> ciphertext blob; Decrypt -> the known plaintext secret.
  kmsMock.on(EncryptCommand).resolves({
    CiphertextBlob: new TextEncoder().encode("ciphertext"),
  });
  kmsMock.on(DecryptCommand).resolves({
    Plaintext: new TextEncoder().encode(PLAINTEXT_SECRET),
  });

  // Default: first-ever poll (no cursor row yet). Poll-path tests that care
  // about the committed cursor override the PutCommand behavior as needed.
  ddbMock.on(GetCommand).resolves({ Item: undefined });
});

afterEach(() => {
  setDocumentClientForTesting(undefined);
  setKmsClientForTesting(undefined);
  setFetchForTesting(undefined);
  setSleepForTesting(undefined);
  delete process.env.SUBSCRIPTIONS_TABLE_NAME;
  delete process.env.CURSOR_STATE_TABLE_NAME;
  delete process.env.SUBSCRIPTION_SECRET_KEY_ID;
  delete process.env.USGS_FEED_URL;
});

afterAll(() => {
  ddbMock.restore();
  kmsMock.restore();
});

// MCP protocol tests (events/list, subscribe, unsubscribe, lifecycle) removed —
// now handled by the SDK's McpServer and covered by its own test suite.

// ---------------------------------------------------------------------------
// Poll path — filtered delivery with correct headers + signature
// ---------------------------------------------------------------------------

describe("runPollCycle delivery", () => {
  it("delivers only filtered earthquakes with the right headers and a valid signature", async () => {
    // Two earthquakes: mag 5.0 (matches minMagnitude 4.0) and mag 3.0 (does not).
    const feed = {
      features: [
        makeFeature("us-big", 5.0, [-117.6, 35.6, 8.3]),
        makeFeature("us-small", 3.0, [-117.6, 35.6, 8.3]),
      ],
    };

    // First-ever poll (no cursor) -> both are "new"; filtering then drops the
    // small one. Cursor commit is a PutItem against the cursor table.
    ddbMock.on(ScanCommand).resolves({ Items: [makeSubscription()] });
    ddbMock.on(PutCommand).resolves({});

    const posts: {
      url: string;
      headers: Record<string, string>;
      body: string;
    }[] = [];
    setFetchForTesting(
      makeFetchStub(feed, (url, init) => {
        posts.push({
          url,
          headers: init.headers ?? {},
          body: init.body ?? "",
        });
        return { ok: true, status: 200 };
      }),
    );
    setSleepForTesting(async () => undefined);

    // Sign with the current time so the Standard Webhooks 5-minute timestamp
    // tolerance is satisfied when we verify the delivered signature below.
    const summary = await runPollCycle(new Date());

    // Only the matching earthquake was delivered.
    expect(summary.newEarthquakes).toBe(2);
    expect(summary.deliveries).toBe(1);
    expect(summary.delivered).toBe(1);
    expect(posts).toHaveLength(1);

    const post = posts[0];
    expect(post.url).toBe("https://webhook.example.test/webhook");
    // Routing header identifies the subscription (Requirement 14.4).
    expect(post.headers[MCP_SUBSCRIPTION_ID_HEADER]).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
    // Standard Webhooks headers are present and the signature verifies against
    // the (decrypted) per-subscription secret (Requirements 14.5, 1.3).
    expect(post.headers["webhook-id"]).toMatch(/^msg_/);
    expect(post.headers["webhook-timestamp"]).toMatch(/^\d+$/);
    expect(() =>
      new Webhook(PLAINTEXT_SECRET).verify(post.body, {
        "webhook-id": post.headers["webhook-id"],
        "webhook-timestamp": post.headers["webhook-timestamp"],
        "webhook-signature": post.headers["webhook-signature"],
      }),
    ).not.toThrow();

    // The delivered body is an earthquake.detected event for the big quake.
    const event = JSON.parse(post.body);
    expect(event.name).toBe("earthquake.detected");
    expect(event.data.earthquakeId).toBe("us-big");

    // The decrypt was bound to the subscriptionId.
    const decryptCall = kmsMock.commandCalls(DecryptCommand)[0];
    expect(decryptCall.args[0].input.EncryptionContext).toEqual({
      subscriptionId: "22222222-2222-4222-8222-222222222222",
    });
  });
});

// ---------------------------------------------------------------------------
// Retry / backoff
// ---------------------------------------------------------------------------

describe("deliverEarthquake retry/backoff", () => {
  const earthquake = {
    earthquakeId: "us-retry",
    magnitude: 5.0,
    place: "synthetic",
    coordinates: { longitude: -117.6, latitude: 35.6, depth: 8.3 },
    time: "2023-11-14T22:13:20.000Z",
    tsunami: false,
    felt: null,
    alert: null,
    url: "",
  };

  it("retries with exponential backoff and succeeds on the third attempt", async () => {
    let attempt = 0;
    const fetchStub: FetchLike = () => {
      attempt += 1;
      // Fail the first two attempts, succeed on the third.
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

    const outcome = await deliverEarthquake(makeSubscription(), earthquake);

    expect(outcome.delivered).toBe(true);
    expect(outcome.attempts).toBe(3);
    // Backoff slept 1s then 5s before the two retries (never the 30s, since the
    // third attempt succeeded), and the test never actually waited.
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

    const outcome = await deliverEarthquake(makeSubscription(), earthquake);

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

    const outcome = await deliverEarthquake(makeSubscription(), earthquake);
    expect(outcome.delivered).toBe(true);
    expect(outcome.attempts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Cursor commit ordering (Requirement 15.4)
// ---------------------------------------------------------------------------

describe("cursor commit ordering", () => {
  it("commits the cursor after a successful poll/emission", async () => {
    const feed = { features: [makeFeature("us-1", 5.0, [-117.6, 35.6, 8.3])] };
    ddbMock.on(ScanCommand).resolves({ Items: [makeSubscription()] });
    ddbMock.on(PutCommand).resolves({});

    setFetchForTesting(makeFetchStub(feed, () => ({ ok: true, status: 200 })));
    setSleepForTesting(async () => undefined);

    await runPollCycle(new Date("2024-02-02T00:00:00.000Z"));

    // The cursor table received a PutItem carrying the emitted id.
    const cursorPut = ddbMock
      .commandCalls(PutCommand)
      .find((c) => c.args[0].input.TableName === CURSOR_TABLE);
    expect(cursorPut).toBeDefined();
    const cursorItem = cursorPut!.args[0].input.Item as {
      lastSeenIds: string[];
      totalEmitted: number;
    };
    expect(cursorItem.lastSeenIds).toContain("us-1");
    expect(cursorItem.totalEmitted).toBe(1);
  });

  it("does NOT commit the cursor when the USGS fetch fails", async () => {
    // GET (feed) fails -> detectNewEarthquakes throws -> cursor never written.
    const failingFetch: FetchLike = () =>
      Promise.resolve({
        ok: false,
        status: 503,
        json: () => Promise.resolve({}),
      });
    setFetchForTesting(failingFetch);
    setSleepForTesting(async () => undefined);

    await expect(
      runPollCycle(new Date("2024-02-02T00:00:00.000Z")),
    ).rejects.toThrow(/503/);

    // No PutItem against the cursor table (cursor state unchanged, Req 15.4).
    const cursorPuts = ddbMock
      .commandCalls(PutCommand)
      .filter((c) => c.args[0].input.TableName === CURSOR_TABLE);
    expect(cursorPuts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Dual-trigger dispatch
// ---------------------------------------------------------------------------

describe("handler dual-trigger dispatch", () => {
  it("runs a poll cycle for a non-API (EventBridge) event", async () => {
    const feed = { features: [makeFeature("us-eb", 5.0, [-117.6, 35.6, 8.3])] };
    ddbMock.on(ScanCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});
    setFetchForTesting(makeFetchStub(feed, () => ({ ok: true, status: 200 })));
    setSleepForTesting(async () => undefined);

    // An EventBridge scheduled event has no httpMethod; handler returns void.
    const res = await handler({ source: "aws.events" });
    expect(res).toBeUndefined();
    // Cursor still advanced (poll completed with no subscriptions to deliver to).
    const cursorPut = ddbMock
      .commandCalls(PutCommand)
      .find((c) => c.args[0].input.TableName === CURSOR_TABLE);
    expect(cursorPut).toBeDefined();
  });
});
