/**
 * Property 14: Subscription Creation Response Validity.
 *
 * Exercises MCP Server 2's `events/subscribe` creation path (task 7.3) with
 * fast-check: for ANY valid `events/subscribe` request the server SHALL return
 * a response containing
 *
 *   - a `subscriptionId` that is a valid UUID v4, and
 *   - an `expiresAt` timestamp strictly in the future relative to the request
 *     time.
 *
 * A "valid request" is generated broadly across the input space the shared
 * `subscribeParamsSchema` admits: the `briefing.trigger` event name, an HTTPS
 * webhook URL, a client-supplied `whsec_` secret whose body decodes to 24-64
 * bytes, an optional valid 5-field cron `schedule`, an optional positive `ttl`,
 * and the optional `customerId` extension field (a UUID v4). Every generated
 * candidate is additionally filtered through `subscribeParamsSchema` so the
 * property only ever feeds the server inputs the protocol accepts.
 *
 * The property is checked from BOTH entry points:
 *   A. through the dual-trigger `handler` over a JSON-RPC `events/subscribe`
 *      request (the public MCP HTTP transport surface), and
 *   B. through the `createSubscription` helper directly with an explicit
 *      request instant, so "in the future" is asserted against a known `now`.
 *
 * KMS `Encrypt` is mocked to return a ciphertext blob and DynamoDB `PutCommand`
 * to resolve, so no real AWS calls occur and the test isolates the response
 * contract (UUID id + future expiry) from persistence/crypto side effects.
 *
 * **Validates: Requirement 14.3**
 */

import { EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  EVENT_NAME_BRIEFING_TRIGGER,
  UUID_V4_REGEX,
  subscribeParamsSchema,
  subscribeResultSchema,
  uuidV4Schema,
} from "@mcp-events/shared";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import fc from "fast-check";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSubscription, handler } from "./handler.js";

/** Per-property run count. Spec floor is 100 random inputs per property. */
const NUM_RUNS = 100;

const SUBSCRIPTIONS_TABLE = "test-subscriptions";
const KEY_ID = "arn:aws:kms:us-east-1:111122223333:key/test-key";

const ddbMock = mockClient(DynamoDBDocumentClient);
const kmsMock = mockClient(KMSClient);

// ---------------------------------------------------------------------------
// Generators — valid events/subscribe requests
// ---------------------------------------------------------------------------

/**
 * A structurally valid Standard Webhooks `whsec_` secret: the literal prefix
 * `whsec_` followed by base64 of 24-64 random bytes (the design's secret
 * format, the bound `whsecSecretSchema` enforces). Generating from explicit
 * bytes keeps the decoded length inside the required 24-64 window.
 */
const validSecretArb: fc.Arbitrary<string> = fc
  .uint8Array({ minLength: 24, maxLength: 64 })
  .map((bytes) => `whsec_${Buffer.from(bytes).toString("base64")}`);

/** An HTTPS webhook callback URL (the schema rejects non-HTTPS URLs). */
const validHttpsUrlArb: fc.Arbitrary<string> = fc.webUrl({
  validSchemes: ["https"],
});

// A single cron atom (wildcard, single value, range, wildcard-step, or
// value-step) plus comma lists, matching the shared CRON_REGEX structurally.
const cronAtomArb = fc.oneof(
  fc.constant("*"),
  fc.integer({ min: 0, max: 59 }).map((n) => `${n}`),
  fc
    .tuple(fc.integer({ min: 0, max: 59 }), fc.integer({ min: 0, max: 59 }))
    .map(([a, b]) => `${Math.min(a, b)}-${Math.max(a, b)}`),
  fc.integer({ min: 1, max: 59 }).map((n) => `*/${n}`),
  fc
    .tuple(fc.integer({ min: 0, max: 59 }), fc.integer({ min: 1, max: 59 }))
    .map(([a, b]) => `${a}/${b}`),
);
const cronFieldArb = fc
  .array(cronAtomArb, { minLength: 1, maxLength: 4 })
  .map((atoms) => atoms.join(","));
const validCronArb: fc.Arbitrary<string> = fc
  .tuple(cronFieldArb, cronFieldArb, cronFieldArb, cronFieldArb, cronFieldArb)
  .map((fields) => fields.join(" "));

/** Positive integer TTL in seconds (the schema requires int().positive()). */
const validTtlArb = fc.integer({ min: 1, max: 10_000_000 });

/**
 * A valid `events/subscribe` params object, varying the URL, secret byte
 * length, presence/absence of the cron schedule and ttl, and the optional
 * `customerId` extension. Candidates are filtered through the shared schema so
 * only protocol-valid requests reach the server under test.
 */
const validSubscribeParamsArb = fc
  .record(
    {
      event: fc.constant(EVENT_NAME_BRIEFING_TRIGGER),
      delivery: fc.record({
        mode: fc.constant("webhook" as const),
        url: validHttpsUrlArb,
        secret: validSecretArb,
      }),
      inputSchema: fc.option(fc.record({ schedule: validCronArb }), {
        nil: undefined,
      }),
      ttl: fc.option(validTtlArb, { nil: undefined }),
      customerId: fc.option(fc.uuid({ version: 4 }), { nil: undefined }),
    },
    { requiredKeys: ["event", "delivery"] },
  )
  // Drop undefined optional keys so the object mirrors a real wire request, and
  // keep only candidates the protocol schema accepts (a no-op safety net: an
  // HTTPS URL + valid whsec_ + valid cron + positive ttl always parse).
  .map((params) => {
    const cleaned: Record<string, unknown> = {
      event: params.event,
      delivery: params.delivery,
    };
    if (params.inputSchema !== undefined) {
      cleaned.inputSchema = params.inputSchema;
    }
    if (params.ttl !== undefined) {
      cleaned.ttl = params.ttl;
    }
    if (params.customerId !== undefined) {
      cleaned.customerId = params.customerId;
    }
    return cleaned;
  })
  .filter((params) => subscribeParamsSchema.safeParse(params).success);

// ---------------------------------------------------------------------------
// Setup / teardown — mock KMS Encrypt + DynamoDB PutCommand (no real AWS)
// ---------------------------------------------------------------------------

beforeEach(() => {
  ddbMock.reset();
  kmsMock.reset();

  process.env.SUBSCRIPTIONS_TABLE_NAME = SUBSCRIPTIONS_TABLE;
  process.env.SUBSCRIPTION_SECRET_KEY_ID = KEY_ID;

  // The handler caches a DynamoDB document client and a KMS client as module
  // singletons created from the real SDK; aws-sdk-client-mock intercepts the
  // command sends, so no network call happens. Encrypt -> ciphertext blob,
  // Put -> resolved write.
  kmsMock.on(EncryptCommand).resolves({
    CiphertextBlob: new TextEncoder().encode("ciphertext"),
  });
  ddbMock.on(PutCommand).resolves({});
});

afterEach(() => {
  delete process.env.SUBSCRIPTIONS_TABLE_NAME;
  delete process.env.SUBSCRIPTION_SECRET_KEY_ID;
});

afterAll(() => {
  ddbMock.restore();
  kmsMock.restore();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an API Gateway proxy event posting a JSON-RPC request to /mcp. */
function makeSubscribeEvent(
  params: unknown,
  id: string | number,
): APIGatewayProxyEvent {
  return {
    httpMethod: "POST",
    resource: "/mcp",
    path: "/mcp",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "events/subscribe",
      params,
    }),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEvent;
}

/** Assert a SubscribeResult satisfies Property 14 relative to `requestMs`. */
function assertValidSubscribeResult(
  result: { subscriptionId?: unknown; expiresAt?: unknown } | undefined,
  requestMs: number,
): void {
  expect(result).toBeDefined();

  // subscriptionId is a valid UUID v4.
  expect(typeof result?.subscriptionId).toBe("string");
  expect(result?.subscriptionId as string).toMatch(UUID_V4_REGEX);
  expect(uuidV4Schema.safeParse(result?.subscriptionId).success).toBe(true);

  // expiresAt parses to a timestamp strictly in the future of the request time.
  expect(typeof result?.expiresAt).toBe("string");
  const expiresMs = Date.parse(result?.expiresAt as string);
  expect(Number.isNaN(expiresMs)).toBe(false);
  expect(expiresMs).toBeGreaterThan(requestMs);

  // The whole response also satisfies the shared result schema (UUID v4 id +
  // ISO 8601 expiresAt).
  expect(subscribeResultSchema.safeParse(result).success).toBe(true);
}

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe("Property 14: Subscription Creation Response Validity", () => {
  it("14.3: handler events/subscribe returns a valid UUID subscriptionId and a future expiresAt for any valid request", async () => {
    await fc.assert(
      fc.asyncProperty(
        validSubscribeParamsArb,
        fc.oneof(fc.string(), fc.integer()),
        async (params, rpcId) => {
          // Request time: expiresAt must be strictly after this instant.
          const requestMs = Date.now();

          const res = await handler(makeSubscribeEvent(params, rpcId));
          expect(res).toBeDefined();

          const body = JSON.parse((res as APIGatewayProxyResult).body) as {
            result?: { subscriptionId?: unknown; expiresAt?: unknown };
            error?: { code: number; message: string };
          };
          // A valid request never produces a JSON-RPC error.
          expect(body.error).toBeUndefined();
          assertValidSubscribeResult(body.result, requestMs);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("14.3: createSubscription returns a valid UUID subscriptionId and an expiresAt after the request instant", async () => {
    await fc.assert(
      fc.asyncProperty(
        validSubscribeParamsArb,
        fc.date({
          min: new Date("2000-01-01T00:00:00.000Z"),
          max: new Date("2100-01-01T00:00:00.000Z"),
        }),
        async (params, now) => {
          const parsed = subscribeParamsSchema.parse(params);

          const result = await createSubscription(
            {
              event: parsed.event,
              callbackUrl: parsed.delivery.url,
              secret: parsed.delivery.secret,
              schedule: parsed.inputSchema?.schedule,
              ttlSeconds: parsed.ttl ?? 1800,
            },
            now,
          );

          // expiresAt is strictly after the explicit request instant `now`.
          assertValidSubscribeResult(result, now.getTime());
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
