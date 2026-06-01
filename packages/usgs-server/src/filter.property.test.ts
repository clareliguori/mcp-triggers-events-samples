/**
 * Property 4: Per-Customer Earthquake Filtering.
 *
 * Exercises the pure per-subscription filter logic (task 6.3) with fast-check.
 * For any earthquake `q` and subscription filter `f`, MCP Server 1 must deliver
 * `q` to `f` if and only if every SET filter dimension is satisfied (logical
 * AND): `magnitude >= minMagnitude` (12.1) AND `depth <= maxDepthKm` (12.3) AND
 * the coordinates fall within `region` (12.2); with no filter params set, every
 * earthquake is delivered (12.4).
 *
 * The expected decision is computed by an INDEPENDENT oracle expressed directly
 * from the acceptance criteria — the AND-composition of the magnitude floor,
 * depth ceiling, and region containment, plus the no-filter passthrough — and
 * asserted equal to {@link matchesFilter}'s output. The oracle reuses
 * {@link isInRegion} / {@link REGION_BOUNDS} for the geographic predicate
 * deliberately: the region's bounding-box geometry IS the implementation's
 * definition of "within region", so the meaningful things proven here are the
 * boolean composition and the numeric comparisons, not a re-derivation of the
 * geometry. (The geometry itself is covered by the unit tests in
 * `filter.test.ts`.)
 *
 * Four framings are checked:
 *
 *   A. Property 4 proper — single `(earthquake, filter)` decision matches the
 *      oracle EXACTLY, with boundary emphasis (earthquake magnitude/depth that
 *      sometimes land exactly on, just below, and just above the filter's
 *      thresholds), so the inclusive `>=` / `<=` edges are hit often.
 *
 *   B. 12.4 — an undefined filter, an empty filter `{}`, and an all-`undefined`
 *      filter each deliver EVERY earthquake.
 *
 *   C. 1.5 — subscription isolation: whether a subscription is selected by
 *      {@link matchingSubscriptions} over a whole set depends only on that one
 *      subscription (and the earthquake), never on its neighbours; and the
 *      selection equals the per-subscription oracle exactly.
 *
 *   D. 1.2 — {@link computeDeliveries} yields EXACTLY the matching
 *      `(earthquake, subscription)` pairs for ACTIVE subscriptions (earthquake
 *      order, then subscription order), and never emits a non-active one.
 *
 * **Validates: Requirements 1.2, 1.5, 12.1, 12.2, 12.3, 12.4**
 */

import type {
  EarthquakeDetectedData,
  Region,
  SubscriptionParams,
  WebhookSubscription,
} from "@mcp-events/shared";
import { REGIONS } from "@mcp-events/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  type EarthquakeDelivery,
  REGION_BOUNDS,
  computeDeliveries,
  isInRegion,
  matchesFilter,
  matchingSubscriptions,
} from "./filter.js";

/** Per-property run count. Spec floor is 100 random inputs per property. */
const NUM_RUNS = 100;

// ---------------------------------------------------------------------------
// Independent oracle (expressed straight from the acceptance criteria)
// ---------------------------------------------------------------------------

/**
 * The expected delivery decision for one `(earthquake, filter)` pair, derived
 * directly from Requirements 12.1-12.4 as an AND of three independent
 * predicates. Region containment reuses {@link isInRegion} on purpose (see the
 * file header): the box geometry is the implementation's definition of "within
 * region", so what this oracle proves independently is the AND-composition and
 * the magnitude/depth comparisons and the no-filter passthrough.
 */
function expectedMatch(
  earthquake: EarthquakeDetectedData,
  filter?: SubscriptionParams,
): boolean {
  // 12.4 — no filter object at all delivers everything.
  if (!filter) {
    return true;
  }

  // 12.1 — magnitude floor (inclusive). Unset dimension does not constrain.
  const magnitudeOk =
    filter.minMagnitude === undefined ||
    earthquake.magnitude >= filter.minMagnitude;

  // 12.3 — depth ceiling (inclusive). Unset dimension does not constrain.
  const depthOk =
    filter.maxDepthKm === undefined ||
    earthquake.coordinates.depth <= filter.maxDepthKm;

  // 12.2 — geographic region. Unset dimension does not constrain.
  const regionOk =
    filter.region === undefined ||
    isInRegion(earthquake.coordinates, filter.region);

  return magnitudeOk && depthOk && regionOk;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** A USGS-style earthquake ID, e.g. "us7000n123". */
const usgsIdArb: fc.Arbitrary<string> = fc
  .string({ minLength: 4, maxLength: 12, unit: "grapheme-ascii" })
  .map((s) => `us${s}`);

/**
 * An arbitrary latitude/longitude. Latitude stays in `[-90, 90]`; longitude
 * deliberately ranges beyond `[-180, 180)` so {@link isInRegion}'s longitude
 * normalization is exercised by the same inputs that drive the oracle.
 */
const arbitraryLatLonArb = fc.record({
  latitude: fc.double({ min: -90, max: 90, noNaN: true }),
  longitude: fc.double({ min: -360, max: 360, noNaN: true }),
});

/**
 * A latitude/longitude guaranteed to fall INSIDE the given region's bounding
 * box. Biasing toward region interiors ensures the region-match branch is
 * exercised often (purely random points over the whole globe land inside any
 * one region only sometimes), giving both `true` and `false` region outcomes
 * good coverage. The Pacific box crosses the antimeridian (`lonMin > lonMax`),
 * so its interior longitude is drawn from either side of the date line.
 */
function regionInteriorLatLonArb(
  region: Region,
): fc.Arbitrary<{ latitude: number; longitude: number }> {
  const bounds = REGION_BOUNDS[region];
  const latitude = fc.double({
    min: bounds.latMin,
    max: bounds.latMax,
    noNaN: true,
  });
  const longitude =
    bounds.lonMin <= bounds.lonMax
      ? fc.double({ min: bounds.lonMin, max: bounds.lonMax, noNaN: true })
      : fc.oneof(
          fc.double({ min: bounds.lonMin, max: 180, noNaN: true }),
          fc.double({ min: -180, max: bounds.lonMax, noNaN: true }),
        );
  return fc.record({ latitude, longitude });
}

const latLonArb = fc.oneof(
  arbitraryLatLonArb,
  fc.constantFrom(...REGIONS).chain(regionInteriorLatLonArb),
);

/**
 * A number generator that, when a threshold is supplied, sometimes lands
 * EXACTLY on it (and just below / just above), so the inclusive `>=` and `<=`
 * boundaries are hit far more often than random sampling would manage. When no
 * threshold applies, it is a plain bounded double.
 */
function numberWithBoundaryEmphasisArb(
  threshold: number | undefined,
  range: { min: number; max: number },
): fc.Arbitrary<number> {
  const base = fc.double({ min: range.min, max: range.max, noNaN: true });
  if (threshold === undefined) {
    return base;
  }
  return fc.oneof(
    base,
    fc.constant(threshold), // exactly on the inclusive edge
    fc.constant(threshold - 0.05), // just inside / outside the edge
    fc.constant(threshold + 0.05),
  );
}

/** Assemble a structurally valid earthquake from its variable parts. */
function makeEarthquake(parts: {
  earthquakeId: string;
  magnitude: number;
  latitude: number;
  longitude: number;
  depth: number;
}): EarthquakeDetectedData {
  return {
    earthquakeId: parts.earthquakeId,
    magnitude: parts.magnitude,
    place: "synthetic event",
    coordinates: {
      longitude: parts.longitude,
      latitude: parts.latitude,
      depth: parts.depth,
    },
    time: "2023-11-14T22:13:20.000Z",
    tsunami: false,
    felt: null,
    alert: null,
    url: "",
  };
}

/** An optional filter; each dimension is independently present or absent. */
const filterArb: fc.Arbitrary<SubscriptionParams> = fc.record({
  minMagnitude: fc.option(fc.double({ min: 0, max: 10, noNaN: true }), {
    nil: undefined,
  }),
  region: fc.option(fc.constantFrom(...REGIONS), { nil: undefined }),
  maxDepthKm: fc.option(fc.double({ min: 0, max: 700, noNaN: true }), {
    nil: undefined,
  }),
});

/**
 * Property 4's core unit: a `(filter, earthquake)` pair where the earthquake's
 * magnitude and depth are drawn with boundary emphasis around the filter's
 * thresholds (12.1 / 12.3) and its coordinates are biased toward region
 * interiors (12.2).
 */
const filterAndEarthquakeArb = filterArb.chain((filter) =>
  fc
    .record({
      earthquakeId: usgsIdArb,
      magnitude: numberWithBoundaryEmphasisArb(filter.minMagnitude, {
        min: -2,
        max: 12,
      }),
      depth: numberWithBoundaryEmphasisArb(filter.maxDepthKm, {
        min: 0,
        max: 700,
      }),
      latLon: latLonArb,
    })
    .map(({ earthquakeId, magnitude, depth, latLon }) => ({
      filter,
      earthquake: makeEarthquake({
        earthquakeId,
        magnitude,
        depth,
        latitude: latLon.latitude,
        longitude: latLon.longitude,
      }),
    })),
);

/** A general (filter-agnostic) earthquake for the set-level properties. */
const earthquakeArb: fc.Arbitrary<EarthquakeDetectedData> = fc
  .record({
    earthquakeId: usgsIdArb,
    magnitude: fc.double({ min: -2, max: 12, noNaN: true }),
    depth: fc.double({ min: 0, max: 700, noNaN: true }),
    latLon: latLonArb,
  })
  .map(({ earthquakeId, magnitude, depth, latLon }) =>
    makeEarthquake({
      earthquakeId,
      magnitude,
      depth,
      latitude: latLon.latitude,
      longitude: latLon.longitude,
    }),
  );

/** Build an active-by-default webhook subscription with the given filter. */
function makeSubscription(
  subscriptionId: string,
  filterParams: SubscriptionParams | undefined,
  status: WebhookSubscription["status"],
): WebhookSubscription {
  return {
    subscriptionId,
    customerId: `customer-${subscriptionId}`,
    serverEndpoint: "https://usgs-mcp.example.test/mcp",
    eventName: "earthquake.detected",
    callbackUrl: "https://webhook.example.test/webhook",
    encryptedSecret: "ciphertext",
    filterParams,
    createdAt: "2024-01-01T00:00:00.000Z",
    expiresAt: "2024-01-01T00:30:00.000Z",
    lastRefreshedAt: "2024-01-01T00:00:00.000Z",
    status,
  };
}

/**
 * A set of subscriptions with distinct IDs, each with an optional filter (which
 * may itself be a no-op all-`undefined` filter) and an arbitrary lifecycle
 * status, so non-active subscriptions are present too.
 */
const subscriptionsArb: fc.Arbitrary<WebhookSubscription[]> = fc
  .array(
    fc.record({
      filterParams: fc.option(filterArb, { nil: undefined }),
      status: fc.constantFrom<WebhookSubscription["status"]>(
        "active",
        "expired",
        "failed",
      ),
    }),
    { maxLength: 8 },
  )
  .map((configs) =>
    configs.map((config, index) =>
      makeSubscription(`sub-${index}`, config.filterParams, config.status),
    ),
  );

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("Property 4: Per-Customer Earthquake Filtering", () => {
  it("12.1/12.2/12.3/12.4: matchesFilter equals the independent AND-of-criteria oracle", () => {
    fc.assert(
      fc.property(filterAndEarthquakeArb, ({ filter, earthquake }) => {
        expect(matchesFilter(earthquake, filter)).toBe(
          expectedMatch(earthquake, filter),
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("12.4: an undefined / empty / all-undefined filter delivers every earthquake", () => {
    fc.assert(
      fc.property(earthquakeArb, (earthquake) => {
        expect(matchesFilter(earthquake)).toBe(true);
        expect(matchesFilter(earthquake, {})).toBe(true);
        expect(
          matchesFilter(earthquake, {
            minMagnitude: undefined,
            region: undefined,
            maxDepthKm: undefined,
          }),
        ).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("1.5: subscription selection is isolated and matches the per-subscription oracle", () => {
    fc.assert(
      fc.property(earthquakeArb, subscriptionsArb, (earthquake, subs) => {
        const selected = matchingSubscriptions(earthquake, subs);

        // Exactness: the selected set equals the per-subscription oracle,
        // preserving input order (active AND filter-match).
        const oracle = subs.filter(
          (s) =>
            s.status === "active" && expectedMatch(earthquake, s.filterParams),
        );
        expect(selected).toEqual(oracle);

        // Isolation (Req 1.5): a subscription's membership in the whole-set
        // result depends ONLY on that subscription evaluated alone — never on
        // its neighbours.
        const selectedIds = new Set(selected.map((s) => s.subscriptionId));
        for (const subscription of subs) {
          const alone = matchingSubscriptions(earthquake, [subscription]);
          expect(selectedIds.has(subscription.subscriptionId)).toBe(
            alone.length === 1,
          );
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("1.2: computeDeliveries yields exactly the active matching (earthquake, subscription) pairs", () => {
    fc.assert(
      fc.property(
        fc.array(earthquakeArb, { maxLength: 6 }),
        subscriptionsArb,
        (earthquakes, subs) => {
          const deliveries = computeDeliveries(earthquakes, subs);

          // Oracle: earthquake order, then subscription order, ACTIVE only.
          const expected: EarthquakeDelivery[] = [];
          for (const earthquake of earthquakes) {
            for (const subscription of subs) {
              if (
                subscription.status === "active" &&
                expectedMatch(earthquake, subscription.filterParams)
              ) {
                expected.push({ subscription, earthquake });
              }
            }
          }
          expect(deliveries).toEqual(expected);

          // A non-active subscription is never delivered to (Req 1.2 iterates
          // ACTIVE subscriptions only).
          for (const delivery of deliveries) {
            expect(delivery.subscription.status).toBe("active");
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
