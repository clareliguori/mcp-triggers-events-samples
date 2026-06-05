/**
 * Property test for subscription expiry detection and refresh (task 10.3,
 * Property 10).
 *
 * **Property 10: Subscription Expiry Detection and Refresh**
 *
 * _For any_ set of active subscriptions with various expiry times, the
 * Subscription Manager SHALL identify and refresh all subscriptions expiring
 * within the threshold period. _For any_ active customer with missing
 * subscriptions, the Subscription Manager SHALL detect and re-create them.
 *
 * **Validates: Requirements 8.2, 8.5, 15.3**
 *
 * ## Approach
 *
 * These properties drive the REAL pure detection helpers exported by
 * `refresh.ts` (task 10.2) — {@link isExpiringWithin},
 * {@link findExpiringSubscriptions}, and {@link findMissingServers} — with no
 * I/O, SigV4, or AWS access. The orchestration that consumes them
 * (`refreshExpiringSubscriptions`) acts on exactly these outputs (refreshes the
 * subscriptions {@link findExpiringSubscriptions} returns, re-creates the
 * servers {@link findMissingServers} returns), so pinning the helpers down pins
 * down the detection contract the requirements demand.
 *
 * fast-check generates:
 *
 * 1. **Expiry detection (Requirement 8.2 / 15.3).** Arbitrary sets of
 *    subscriptions whose `expiresAt` is a mix of already-expired,
 *    expiring-at-or-within the threshold window, exactly on the boundary, just
 *    outside it, and far-future. Each subscription's offset relative to `now`
 *    is the ground-truth oracle: it is expiring iff `offsetMs <=
 *    thresholdSeconds * 1000`. The property asserts {@link isExpiringWithin}
 *    agrees with the oracle for every subscription and that
 *    {@link findExpiringSubscriptions} returns EXACTLY the expiring subset (same
 *    elements, original order) — no false positives, no misses.
 *
 * 2. **Missing-subscription detection (Requirement 8.5).** Arbitrary subsets of
 *    the required servers' event names present in a customer's subscriptions
 *    (with possible duplicates and multiple records per event), against which
 *    {@link findMissingServers} must return EXACTLY the required servers that
 *    have no subscription record.
 */

import type {
  SubscriptionParams,
  WebhookSubscription,
} from "@mcp-events/shared";
import {
  EVENT_NAME_BRIEFING_TRIGGER,
  EVENT_NAME_EARTHQUAKE_DETECTED,
  SUBSCRIPTION_REFRESH_THRESHOLD_SECONDS,
  WHSEC_SECRET_PREFIX,
} from "@mcp-events/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  REQUIRED_SERVERS,
  SCHEDULER_SERVER,
  USGS_SERVER,
  findExpiringSubscriptions,
  findMissingServers,
  isExpiringWithin,
  type RefreshableEventName,
  type SubscriptionRecord,
} from "./refresh.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Per-property run count. Spec floor is 100 random inputs per property. */
const NUM_RUNS = 100;

/** Structurally valid `whsec_` secret (prefix + base64 of 32 bytes). */
const SECRET = `${WHSEC_SECRET_PREFIX}${Buffer.alloc(32, 7).toString("base64")}`;

/** A fixed far-future expiry for records where expiry is irrelevant. */
const FAR_FUTURE_ISO = "2999-01-01T00:00:00.000Z";

/**
 * Bounds kept comfortably inside the 32-bit range fast-check's `integer` uses by
 * default, so generated `nowMs + offsetMs` stays a valid, representable epoch.
 */
const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;
const ONE_DAY_SECONDS = 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Record builder
// ---------------------------------------------------------------------------

/**
 * Build a complete {@link SubscriptionRecord} for a given event name and expiry.
 * Only `eventName` and `expiresAt` are consulted by the pure helpers under test,
 * but the rest of the record is populated so the value is type-correct and
 * realistic (mirroring what the Data API returns).
 */
function makeSubscription(
  eventName: RefreshableEventName,
  expiresAt: string,
  index: number,
): SubscriptionRecord {
  const isEarthquake = eventName === EVENT_NAME_EARTHQUAKE_DETECTED;
  const filterParams: SubscriptionParams = { minMagnitude: 4.5 };
  return {
    subscriptionId: `00000000-0000-4000-8000-${index
      .toString(16)
      .padStart(12, "0")}`,
    customerId: "33333333-3333-4333-8333-333333333333",
    serverEndpoint: "https://mcp.example.test",
    eventName,
    callbackUrl: "https://webhook.example.test/webhook",
    secret: SECRET,
    ...(isEarthquake ? { filterParams } : { schedule: 24 }),
    createdAt: "2024-01-01T00:00:00.000Z",
    expiresAt,
    lastRefreshedAt: "2024-01-01T00:00:00.000Z",
    status: "active" as WebhookSubscription["status"],
  };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** One of the two required MCP event names. */
const eventNameArb = fc.constantFrom<RefreshableEventName>(
  EVENT_NAME_EARTHQUAKE_DETECTED,
  EVENT_NAME_BRIEFING_TRIGGER,
);

/** Epoch-ms "now" anywhere in a broad, realistic window. */
const nowMsArb = fc.integer({
  min: Date.parse("2024-01-01T00:00:00.000Z"),
  max: Date.parse("2030-01-01T00:00:00.000Z"),
});

/**
 * A scenario: a reference time, a positive expiry threshold, and a set of
 * subscriptions each placed by an `offsetMs` relative to `now`. The offset
 * categories deliberately span every side of the threshold boundary — already
 * expired, at-or-within, exactly on the boundary, one past it, and far future —
 * so each run mixes subscriptions the helper must keep with ones it must drop.
 */
const expiryScenarioArb = fc
  .record({
    nowMs: nowMsArb,
    // Threshold from 1 second up to a day; the helper compares in milliseconds.
    thresholdSeconds: fc.integer({ min: 1, max: ONE_DAY_SECONDS }),
  })
  .chain(({ nowMs, thresholdSeconds }) => {
    const thresholdMs = thresholdSeconds * 1000;
    // offsetMs relative to `now`; "expiring" iff offsetMs <= thresholdMs.
    const offsetMsArb = fc.oneof(
      fc.integer({ min: -TEN_DAYS_MS, max: -1 }), // already expired
      fc.integer({ min: 0, max: thresholdMs }), // at or within the window
      fc.constant(thresholdMs), // exactly on the boundary (inclusive)
      fc.constant(thresholdMs + 1), // one ms past the boundary
      fc.integer({ min: thresholdMs + 1, max: thresholdMs + TEN_DAYS_MS }), // far future
    );
    return fc.record({
      nowMs: fc.constant(nowMs),
      thresholdSeconds: fc.constant(thresholdSeconds),
      offsets: fc.array(
        fc.record({ eventName: eventNameArb, offsetMs: offsetMsArb }),
        { minLength: 0, maxLength: 12 },
      ),
    });
  });

/**
 * An arbitrary subset of the required event names present in a customer's
 * subscriptions, allowing duplicates and multiple records per event so the
 * property covers "two records for the same server" as well as "none".
 */
const presentEventNamesArb = fc.array(eventNameArb, {
  minLength: 0,
  maxLength: 8,
});

// ---------------------------------------------------------------------------
// Property 10a: Expiry detection
// ---------------------------------------------------------------------------

describe("Property 10: Subscription Expiry Detection", () => {
  it("8.2/15.3: findExpiringSubscriptions returns exactly the subscriptions at or within the threshold window", () => {
    fc.assert(
      fc.property(expiryScenarioArb, ({ nowMs, thresholdSeconds, offsets }) => {
        const thresholdMs = thresholdSeconds * 1000;
        const subscriptions = offsets.map((o, index) =>
          makeSubscription(
            o.eventName,
            new Date(nowMs + o.offsetMs).toISOString(),
            index,
          ),
        );

        // Independent oracle: a subscription is expiring iff its offset from now
        // is at or below the threshold window (inclusive of the boundary, and of
        // already-expired negatives).
        const expectedExpiring = subscriptions.filter(
          (_s, i) => offsets[i].offsetMs <= thresholdMs,
        );

        const actual = findExpiringSubscriptions(
          subscriptions,
          nowMs,
          thresholdSeconds,
        );

        // Exactly the expiring subset, in original order, same element refs.
        expect(actual).toEqual(expectedExpiring);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("8.2: isExpiringWithin agrees with the offset oracle for every subscription", () => {
    fc.assert(
      fc.property(expiryScenarioArb, ({ nowMs, thresholdSeconds, offsets }) => {
        const thresholdMs = thresholdSeconds * 1000;
        for (let i = 0; i < offsets.length; i++) {
          const sub = makeSubscription(
            offsets[i].eventName,
            new Date(nowMs + offsets[i].offsetMs).toISOString(),
            i,
          );
          const expected = offsets[i].offsetMs <= thresholdMs;
          expect(isExpiringWithin(sub, nowMs, thresholdSeconds)).toBe(expected);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("8.2: findExpiringSubscriptions is consistent with isExpiringWithin under the default threshold", () => {
    // Exercises the default-threshold code path (no thresholdSeconds argument),
    // which is what the scheduled refresh run actually uses.
    const defaultThresholdScenarioArb = nowMsArb.chain((nowMs) => {
      const thresholdMs = SUBSCRIPTION_REFRESH_THRESHOLD_SECONDS * 1000;
      const offsetMsArb = fc.oneof(
        fc.integer({ min: -TEN_DAYS_MS, max: -1 }),
        fc.integer({ min: 0, max: thresholdMs }),
        fc.constant(thresholdMs),
        fc.constant(thresholdMs + 1),
        fc.integer({ min: thresholdMs + 1, max: thresholdMs + TEN_DAYS_MS }),
      );
      return fc.record({
        nowMs: fc.constant(nowMs),
        offsets: fc.array(
          fc.record({ eventName: eventNameArb, offsetMs: offsetMsArb }),
          { maxLength: 12 },
        ),
      });
    });

    fc.assert(
      fc.property(defaultThresholdScenarioArb, ({ nowMs, offsets }) => {
        const subscriptions = offsets.map((o, index) =>
          makeSubscription(
            o.eventName,
            new Date(nowMs + o.offsetMs).toISOString(),
            index,
          ),
        );

        const actual = findExpiringSubscriptions(subscriptions, nowMs);

        // The default-threshold result must contain exactly the subscriptions
        // for which the default-threshold isExpiringWithin is true.
        const expected = subscriptions.filter((s) =>
          isExpiringWithin(s, nowMs),
        );
        expect(actual).toEqual(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 10b: Missing-subscription detection
// ---------------------------------------------------------------------------

describe("Property 10: Missing Subscription Detection", () => {
  it("8.5: findMissingServers returns exactly the required servers with no subscription record", () => {
    fc.assert(
      fc.property(presentEventNamesArb, (presentEventNames) => {
        const subscriptions = presentEventNames.map((eventName, index) =>
          makeSubscription(eventName, FAR_FUTURE_ISO, index),
        );

        const present = new Set(presentEventNames);
        // Independent oracle: a required server is missing iff no record carries
        // its event name. Order follows REQUIRED_SERVERS, as the helper returns.
        const expectedMissing = REQUIRED_SERVERS.filter(
          (server) => !present.has(server.eventName),
        );

        const actual = findMissingServers(subscriptions);

        expect(actual).toEqual(expectedMissing);

        // Cross-check: every returned server is genuinely absent, and every
        // required server NOT returned is genuinely present.
        for (const server of actual) {
          expect(present.has(server.eventName)).toBe(false);
        }
        for (const server of REQUIRED_SERVERS) {
          if (!actual.includes(server)) {
            expect(present.has(server.eventName)).toBe(true);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("8.5: known anchor cases — none present, one present, both present", () => {
    // Anchors the general property to the three concrete shapes the scheduled
    // refresh must heal correctly.
    expect(findMissingServers([])).toEqual([USGS_SERVER, SCHEDULER_SERVER]);
    expect(
      findMissingServers([
        makeSubscription(EVENT_NAME_EARTHQUAKE_DETECTED, FAR_FUTURE_ISO, 0),
      ]),
    ).toEqual([SCHEDULER_SERVER]);
    expect(
      findMissingServers([
        makeSubscription(EVENT_NAME_BRIEFING_TRIGGER, FAR_FUTURE_ISO, 0),
      ]),
    ).toEqual([USGS_SERVER]);
    expect(
      findMissingServers([
        makeSubscription(EVENT_NAME_EARTHQUAKE_DETECTED, FAR_FUTURE_ISO, 0),
        makeSubscription(EVENT_NAME_BRIEFING_TRIGGER, FAR_FUTURE_ISO, 1),
      ]),
    ).toEqual([]);
  });
});
