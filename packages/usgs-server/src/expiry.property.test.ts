/**
 * Property: Subscription Expiry Stops Delivery (MCP Server 1).
 *
 * Validates the lifecycle guarantee that if a caller (the Subscription Manager,
 * acting for the MCP Client/Host) ever STOPS refreshing a subscription, that
 * subscription eventually expires and MCP Server 1 stops delivering
 * `earthquake.detected` events to it — even though the subscription record is
 * still physically present in DynamoDB and its filter would otherwise match.
 *
 * Two expiry layers exist (see design Component 1 + Requirement 15.3):
 *
 *   1. The READ-TIME gate — `loadActiveSubscriptions(nowMs)` keeps only records
 *      that are BOTH `status === "active"` AND `Date.parse(expiresAt) > nowMs`.
 *      This is what AUTHORITATIVELY stops delivery: the poll cycle only ever
 *      iterates the survivors of this gate (handler.ts `runPollCycle` ->
 *      `loadActiveSubscriptions` -> `computeDeliveries`).
 *   2. DynamoDB TTL on the mirrored numeric `ttl` attribute — eventual PHYSICAL
 *      cleanup of stale rows, best-effort and lagging (asserted separately in
 *      the CDK template test), NOT the delivery gate.
 *
 * `refreshSubscription` extends both `expiresAt` and `ttl`; with no refresh,
 * `expiresAt` stays fixed, so once wall-clock passes it the read-time gate
 * excludes the subscription on every subsequent poll. These properties pin that
 * behaviour down with fast-check.
 *
 * The properties drive the REAL `loadActiveSubscriptions` over a mocked
 * DynamoDB Scan (aws-sdk-client-mock), then feed its output to the REAL pure
 * `computeDeliveries`, so the full gate -> deliver path is exercised. A matching
 * filter is used throughout precisely so that ONLY expiry (not filtering) can be
 * responsible for a dropped delivery.
 *
 * **Validates: Requirements 1.6, 15.3 (expiry side); supports 14.6**
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type {
  EarthquakeDetectedData,
  WebhookSubscription,
} from "@mcp-events/shared";
import { DEFAULT_SUBSCRIPTION_TTL_SECONDS } from "@mcp-events/shared";
import { mockClient } from "aws-sdk-client-mock";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeDeliveries } from "./filter.js";
import {
  loadActiveSubscriptions,
  setDocumentClientForTesting,
} from "./handler.js";

/** Per-property run count. Spec floor is 100 random inputs per property. */
const NUM_RUNS = 100;

const SUBSCRIPTIONS_TABLE = "test-subscriptions";

const ddbMock = mockClient(DynamoDBDocumentClient);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A magnitude-5 earthquake used as the delivery candidate. Its magnitude clears
 * the subscriptions' `minMagnitude: 4.0` floor and no other filter dimension is
 * set, so the filter ALWAYS matches — isolating expiry as the only possible
 * reason a delivery is dropped.
 */
const EARTHQUAKE: EarthquakeDetectedData = {
  earthquakeId: "us7000test",
  magnitude: 5.0,
  place: "synthetic event",
  coordinates: { longitude: -117.6, latitude: 35.6, depth: 8.3 },
  time: "2023-11-14T22:13:20.000Z",
  tsunami: false,
  felt: null,
  alert: null,
  url: "",
};

/** Build a webhook subscription whose filter matches {@link EARTHQUAKE}. */
function makeSubscription(
  subscriptionId: string,
  status: WebhookSubscription["status"],
  expiresAtMs: number,
): WebhookSubscription {
  return {
    subscriptionId,
    customerId: `11111111-1111-4111-8111-${subscriptionId.padStart(12, "0")}`,
    serverEndpoint: "https://usgs-mcp.example.test",
    eventName: "earthquake.detected",
    callbackUrl: "https://webhook.example.test/webhook",
    encryptedSecret: "ciphertext",
    filterParams: { minMagnitude: 4.0 },
    createdAt: "2024-01-01T00:00:00.000Z",
    expiresAt: new Date(expiresAtMs).toISOString(),
    lastRefreshedAt: "2024-01-01T00:00:00.000Z",
    status,
  };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Epoch-ms "now" anywhere in a broad, realistic window. */
const nowMsArb = fc.integer({
  min: Date.parse("2024-01-01T00:00:00.000Z"),
  max: Date.parse("2030-01-01T00:00:00.000Z"),
});

/** A positive offset in ms, up to ~30 days, used to place expiry around `now`. */
const offsetMsArb = fc.integer({ min: 1, max: 30 * 24 * 60 * 60 * 1000 });

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  ddbMock.reset();
  setDocumentClientForTesting(
    DynamoDBDocumentClient.from(new DynamoDBClient({})),
  );
  process.env.SUBSCRIPTIONS_TABLE_NAME = SUBSCRIPTIONS_TABLE;
});

afterEach(() => {
  setDocumentClientForTesting(undefined);
  delete process.env.SUBSCRIPTIONS_TABLE_NAME;
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("Subscription expiry stops delivery (MCP Server 1)", () => {
  it("15.3: an active subscription past its expiresAt is never loaded, so it receives no delivery (even though its filter matches)", async () => {
    await fc.assert(
      fc.asyncProperty(nowMsArb, offsetMsArb, async (nowMs, pastOffset) => {
        // expiresAt strictly in the past relative to `now`.
        const expiresAtMs = nowMs - pastOffset;
        const sub = makeSubscription("expired", "active", expiresAtMs);
        ddbMock.on(ScanCommand).resolves({ Items: [sub] });

        const active = await loadActiveSubscriptions(nowMs);
        expect(active).toEqual([]);

        // The poll path would feed `active` to computeDeliveries; with the sub
        // gated out, the matching earthquake yields zero deliveries.
        const deliveries = computeDeliveries([EARTHQUAKE], active);
        expect(deliveries).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("delivers while still within the lifetime: an active, not-yet-expired matching subscription is loaded and delivered to", async () => {
    await fc.assert(
      fc.asyncProperty(nowMsArb, offsetMsArb, async (nowMs, futureOffset) => {
        // expiresAt strictly in the future relative to `now`.
        const expiresAtMs = nowMs + futureOffset;
        const sub = makeSubscription("live", "active", expiresAtMs);
        ddbMock.on(ScanCommand).resolves({ Items: [sub] });

        const active = await loadActiveSubscriptions(nowMs);
        expect(active).toHaveLength(1);

        const deliveries = computeDeliveries([EARTHQUAKE], active);
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0].subscription.subscriptionId).toBe("live");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("expiry stops delivery regardless of lifecycle status: a past-expiresAt subscription is dropped for active/expired/failed alike", async () => {
    await fc.assert(
      fc.asyncProperty(
        nowMsArb,
        offsetMsArb,
        fc.constantFrom<WebhookSubscription["status"]>(
          "active",
          "expired",
          "failed",
        ),
        async (nowMs, pastOffset, status) => {
          const sub = makeSubscription("expired", status, nowMs - pastOffset);
          ddbMock.on(ScanCommand).resolves({ Items: [sub] });

          const active = await loadActiveSubscriptions(nowMs);
          expect(active).toEqual([]);
          expect(computeDeliveries([EARTHQUAKE], active)).toEqual([]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("among a mixed set, only active and not-yet-expired subscriptions survive the gate", async () => {
    await fc.assert(
      fc.asyncProperty(
        nowMsArb,
        fc.array(
          fc.record({
            status: fc.constantFrom<WebhookSubscription["status"]>(
              "active",
              "expired",
              "failed",
            ),
            // Offset from `now`: negative => already expired, positive => live.
            offsetMs: fc.integer({
              min: -30 * 24 * 60 * 60 * 1000,
              max: 30 * 24 * 60 * 60 * 1000,
            }),
          }),
          { maxLength: 8 },
        ),
        async (nowMs, configs) => {
          const subs = configs.map((config, index) =>
            makeSubscription(
              String(index),
              config.status,
              nowMs + config.offsetMs,
            ),
          );
          ddbMock.on(ScanCommand).resolves({ Items: subs });

          const active = await loadActiveSubscriptions(nowMs);

          // Independent oracle straight from isSubscriptionActive's contract.
          const expectedIds = subs
            .filter(
              (sub) =>
                sub.status === "active" && Date.parse(sub.expiresAt) > nowMs,
            )
            .map((sub) => sub.subscriptionId);
          expect(active.map((sub) => sub.subscriptionId)).toEqual(expectedIds);

          // Every delivery target is necessarily a survivor of the gate.
          const deliveries = computeDeliveries([EARTHQUAKE], active);
          for (const delivery of deliveries) {
            expect(expectedIds).toContain(delivery.subscription.subscriptionId);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("eventual expiry without refresh: a subscription created with the default TTL stops delivering once now passes created+TTL", async () => {
    await fc.assert(
      fc.asyncProperty(nowMsArb, async (createdAtMs) => {
        // Mirror createSubscription: expiresAt = createdAt + DEFAULT TTL, and
        // the caller never refreshes (expiresAt stays fixed).
        const expiresAtMs =
          createdAtMs + DEFAULT_SUBSCRIPTION_TTL_SECONDS * 1000;
        const sub = makeSubscription("aging", "active", expiresAtMs);
        ddbMock.on(ScanCommand).resolves({ Items: [sub] });

        // Just before expiry: still delivered.
        const justBefore = await loadActiveSubscriptions(expiresAtMs - 1);
        expect(computeDeliveries([EARTHQUAKE], justBefore)).toHaveLength(1);

        // One second after expiry: no longer delivered.
        const afterExpiry = await loadActiveSubscriptions(expiresAtMs + 1000);
        expect(computeDeliveries([EARTHQUAKE], afterExpiry)).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
