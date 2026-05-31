/**
 * Property: Subscription Expiry Stops Delivery (MCP Server 2 — Scheduler).
 *
 * Validates the lifecycle guarantee that if a caller (the Subscription Manager,
 * acting for the MCP Client/Host) ever STOPS refreshing a briefing
 * subscription, that subscription eventually expires and MCP Server 2 stops
 * delivering `briefing.trigger` events to it — even though the record is still
 * physically present in DynamoDB and its cron schedule matches the current
 * minute.
 *
 * As with MCP Server 1, two expiry layers exist (design Component 2 +
 * Requirement 15.3):
 *
 *   1. The READ-TIME gate — `loadActiveSubscriptions(nowMs)` keeps only records
 *      that are BOTH `status === "active"` AND `Date.parse(expiresAt) > nowMs`.
 *      The schedule-check path (handler.ts `runScheduleCheck`) only ever asks
 *      `dueSubscriptions` about the survivors of this gate, so this is what
 *      AUTHORITATIVELY stops delivery.
 *   2. DynamoDB TTL on the mirrored numeric `ttl` attribute — eventual PHYSICAL
 *      cleanup, best-effort and lagging (asserted in the CDK template test), NOT
 *      the delivery gate.
 *
 * `refreshSubscription` extends both `expiresAt` and `ttl`; with no refresh,
 * `expiresAt` stays fixed, so once wall-clock passes it the read-time gate
 * excludes the subscription on every subsequent minute.
 *
 * The properties drive the REAL `loadActiveSubscriptions` over a mocked
 * DynamoDB Scan, then feed its output to the REAL pure `dueSubscriptions`,
 * exercising the full gate -> due path. The cron is built to match the SAME
 * instant used for evaluation precisely so that ONLY expiry (not scheduling)
 * can be responsible for a dropped delivery.
 *
 * **Validates: Requirements 2.3, 15.3 (expiry side); supports 14.6**
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { WebhookSubscription } from "@mcp-events/shared";
import { DEFAULT_SUBSCRIPTION_TTL_SECONDS } from "@mcp-events/shared";
import { mockClient } from "aws-sdk-client-mock";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadActiveSubscriptions,
  setDocumentClientForTesting,
} from "./handler.js";
import { dueSubscriptions } from "./scheduler.js";

/** Per-property run count; ~200 matches the repo's other property tests. */
const NUM_RUNS = 200;

const SUBSCRIPTIONS_TABLE = "test-subscriptions";

const ddbMock = mockClient(DynamoDBDocumentClient);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Build a 5-field cron that fires at the given instant's UTC minute and hour
 * (every day). Evaluating it at that same instant always matches, so a dropped
 * delivery can only be due to expiry, never scheduling.
 */
function cronMatching(date: Date): string {
  return `${date.getUTCMinutes()} ${date.getUTCHours()} * * *`;
}

/** Build an active-by-default briefing subscription with the given schedule. */
function makeSubscription(
  subscriptionId: string,
  status: WebhookSubscription["status"],
  expiresAtMs: number,
  schedule: string,
): WebhookSubscription {
  return {
    subscriptionId,
    customerId: `11111111-1111-4111-8111-${subscriptionId.padStart(12, "0")}`,
    serverEndpoint: "https://scheduler-mcp.example.test",
    eventName: "briefing.trigger",
    callbackUrl: "https://webhook.example.test/webhook",
    encryptedSecret: "ciphertext",
    schedule,
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

describe("Subscription expiry stops delivery (MCP Server 2 — Scheduler)", () => {
  it("15.3: an active briefing subscription past its expiresAt is never loaded, so it is never due (even though its cron matches now)", async () => {
    await fc.assert(
      fc.asyncProperty(nowMsArb, offsetMsArb, async (nowMs, pastOffset) => {
        const now = new Date(nowMs);
        const sub = makeSubscription(
          "expired",
          "active",
          nowMs - pastOffset,
          cronMatching(now),
        );
        ddbMock.on(ScanCommand).resolves({ Items: [sub] });

        const active = await loadActiveSubscriptions(nowMs);
        expect(active).toEqual([]);

        // The schedule-check path feeds `active` to dueSubscriptions; with the
        // sub gated out, nothing is due despite the matching cron.
        expect(dueSubscriptions(active, now)).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("fires while still within the lifetime: an active, not-yet-expired subscription whose cron matches is loaded and due", async () => {
    await fc.assert(
      fc.asyncProperty(nowMsArb, offsetMsArb, async (nowMs, futureOffset) => {
        const now = new Date(nowMs);
        const sub = makeSubscription(
          "live",
          "active",
          nowMs + futureOffset,
          cronMatching(now),
        );
        ddbMock.on(ScanCommand).resolves({ Items: [sub] });

        const active = await loadActiveSubscriptions(nowMs);
        expect(active).toHaveLength(1);

        const due = dueSubscriptions(active, now);
        expect(due).toHaveLength(1);
        expect(due[0].subscriptionId).toBe("live");
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
          const now = new Date(nowMs);
          const sub = makeSubscription(
            "expired",
            status,
            nowMs - pastOffset,
            cronMatching(now),
          );
          ddbMock.on(ScanCommand).resolves({ Items: [sub] });

          const active = await loadActiveSubscriptions(nowMs);
          expect(active).toEqual([]);
          expect(dueSubscriptions(active, now)).toEqual([]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("among a mixed set, only active and not-yet-expired subscriptions survive the gate and can be due", async () => {
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
          const now = new Date(nowMs);
          const cron = cronMatching(now); // every sub's cron matches `now`
          const subs = configs.map((config, index) =>
            makeSubscription(
              String(index),
              config.status,
              nowMs + config.offsetMs,
              cron,
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

          // Since every cron matches `now`, the due set is exactly the gate
          // survivors — no expired/inactive subscription is ever due.
          const due = dueSubscriptions(active, now);
          expect(due.map((sub) => sub.subscriptionId)).toEqual(expectedIds);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("eventual expiry without refresh: a subscription created with the default TTL stops firing once now passes created+TTL", async () => {
    await fc.assert(
      fc.asyncProperty(nowMsArb, async (createdAtMs) => {
        // Mirror createSubscription: expiresAt = createdAt + DEFAULT TTL, and
        // the caller never refreshes (expiresAt stays fixed).
        const expiresAtMs =
          createdAtMs + DEFAULT_SUBSCRIPTION_TTL_SECONDS * 1000;
        // A cron that matches every minute, so scheduling is never the reason
        // a delivery is dropped — only expiry.
        const sub = makeSubscription(
          "aging",
          "active",
          expiresAtMs,
          "* * * * *",
        );
        ddbMock.on(ScanCommand).resolves({ Items: [sub] });

        // Just before expiry: still due.
        const justBefore = await loadActiveSubscriptions(expiresAtMs - 1);
        expect(
          dueSubscriptions(justBefore, new Date(expiresAtMs - 1)),
        ).toHaveLength(1);

        // One second after expiry: no longer due.
        const afterExpiry = await loadActiveSubscriptions(expiresAtMs + 1000);
        expect(
          dueSubscriptions(afterExpiry, new Date(expiresAtMs + 1000)),
        ).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
