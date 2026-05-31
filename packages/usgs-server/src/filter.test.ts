/**
 * Unit tests for per-subscription earthquake filtering (task 6.3).
 *
 * These exercise the pure filter logic across each dimension and their
 * combinations (Requirements 12.1-12.4), boundary values (magnitude/depth
 * exactly equal, region edges), no-filter passthrough, and the multi-earthquake
 * / multi-subscription iteration that produces delivery pairs (Requirements
 * 1.2, 1.5). The fast-check property test for this logic lives in task 6.4.
 */

import type {
  EarthquakeDetectedData,
  Region,
  SubscriptionParams,
  WebhookSubscription,
} from "@mcp-events/shared";
import { describe, expect, it } from "vitest";

import {
  type EarthquakeDelivery,
  REGION_BOUNDS,
  computeDeliveries,
  isInRegion,
  matchesFilter,
  matchingSubscriptions,
  normalizeLongitude,
} from "./filter.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build an earthquake with sensible defaults, overridable per field. */
function makeEarthquake(
  overrides: Partial<EarthquakeDetectedData> = {},
): EarthquakeDetectedData {
  return {
    earthquakeId: "us7000abcd",
    magnitude: 4.2,
    place: "10km SW of Ridgecrest, CA",
    coordinates: { longitude: -117.6, latitude: 35.6, depth: 8.3 },
    time: "2023-11-14T22:13:20.000Z",
    tsunami: false,
    felt: null,
    alert: null,
    url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd",
    ...overrides,
  };
}

/** Build an active webhook subscription with the given filter params. */
function makeSubscription(
  subscriptionId: string,
  filterParams?: SubscriptionParams,
  status: WebhookSubscription["status"] = "active",
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

/** A coordinate comfortably inside each region's bounding box. */
const REGION_INTERIOR: Record<Region, { longitude: number; latitude: number }> =
  {
    pacific: { longitude: 150, latitude: 0 }, // western Pacific
    americas: { longitude: -100, latitude: 40 }, // North America
    europe: { longitude: 10, latitude: 50 }, // central Europe
    asia: { longitude: 100, latitude: 40 }, // central Asia
    africa: { longitude: 20, latitude: 0 }, // equatorial Africa
  };

// ---------------------------------------------------------------------------
// normalizeLongitude
// ---------------------------------------------------------------------------

describe("normalizeLongitude", () => {
  it("leaves in-range longitudes unchanged", () => {
    expect(normalizeLongitude(0)).toBe(0);
    expect(normalizeLongitude(-117.6)).toBeCloseTo(-117.6, 10);
    expect(normalizeLongitude(179)).toBeCloseTo(179, 10);
  });

  it("wraps out-of-range longitudes into [-180, 180)", () => {
    expect(normalizeLongitude(180)).toBe(-180);
    expect(normalizeLongitude(190)).toBeCloseTo(-170, 10);
    expect(normalizeLongitude(-190)).toBeCloseTo(170, 10);
    expect(normalizeLongitude(540)).toBe(-180);
  });
});

// ---------------------------------------------------------------------------
// isInRegion
// ---------------------------------------------------------------------------

describe("isInRegion", () => {
  it("matches a coordinate inside each region's box", () => {
    for (const region of Object.keys(REGION_BOUNDS) as Region[]) {
      const interior = REGION_INTERIOR[region];
      expect(
        isInRegion({ ...interior, depth: 10 }, region),
        `expected interior point to match ${region}`,
      ).toBe(true);
    }
  });

  it("rejects a coordinate outside a region (latitude out of band)", () => {
    // Antarctica latitude is below every region's latMin.
    expect(
      isInRegion({ longitude: 10, latitude: -85, depth: 10 }, "europe"),
    ).toBe(false);
    expect(
      isInRegion({ longitude: -100, latitude: -85, depth: 10 }, "americas"),
    ).toBe(false);
  });

  it("treats latitude bounds as inclusive (boundary value)", () => {
    const { latMin, latMax, lonMin } = REGION_BOUNDS.africa;
    expect(
      isInRegion({ longitude: lonMin, latitude: latMin, depth: 1 }, "africa"),
    ).toBe(true);
    expect(
      isInRegion({ longitude: lonMin, latitude: latMax, depth: 1 }, "africa"),
    ).toBe(true);
    // Just outside the southern edge.
    expect(
      isInRegion(
        { longitude: lonMin, latitude: latMin - 0.01, depth: 1 },
        "africa",
      ),
    ).toBe(false);
  });

  it("handles the Pacific's antimeridian-crossing box on both sides", () => {
    // Western Pacific (positive longitude near the date line).
    expect(
      isInRegion({ longitude: 170, latitude: 0, depth: 10 }, "pacific"),
    ).toBe(true);
    // Eastern Pacific (negative longitude west of the Americas).
    expect(
      isInRegion({ longitude: -120, latitude: 0, depth: 10 }, "pacific"),
    ).toBe(true);
    // Inside the "gap" (Atlantic / Africa longitudes) is NOT in the Pacific.
    expect(
      isInRegion({ longitude: 0, latitude: 0, depth: 10 }, "pacific"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// matchesFilter — single dimension
// ---------------------------------------------------------------------------

describe("matchesFilter", () => {
  it("delivers all earthquakes when filter is undefined (12.4)", () => {
    expect(matchesFilter(makeEarthquake())).toBe(true);
  });

  it("delivers all earthquakes when every filter field is undefined (12.4)", () => {
    expect(matchesFilter(makeEarthquake(), {})).toBe(true);
  });

  describe("minMagnitude (12.1)", () => {
    it("delivers when magnitude is above the floor", () => {
      expect(
        matchesFilter(makeEarthquake({ magnitude: 5.0 }), {
          minMagnitude: 4.0,
        }),
      ).toBe(true);
    });

    it("delivers when magnitude exactly equals the floor (boundary, >=)", () => {
      expect(
        matchesFilter(makeEarthquake({ magnitude: 4.0 }), {
          minMagnitude: 4.0,
        }),
      ).toBe(true);
    });

    it("rejects when magnitude is below the floor", () => {
      expect(
        matchesFilter(makeEarthquake({ magnitude: 3.9 }), {
          minMagnitude: 4.0,
        }),
      ).toBe(false);
    });

    it("treats minMagnitude of 0 as a real bound, not unset", () => {
      // A magnitude of exactly 0 still passes a 0 floor (>=).
      expect(
        matchesFilter(makeEarthquake({ magnitude: 0 }), { minMagnitude: 0 }),
      ).toBe(true);
    });
  });

  describe("maxDepthKm (12.3)", () => {
    it("delivers when depth is below the ceiling", () => {
      expect(
        matchesFilter(
          makeEarthquake({
            coordinates: { longitude: 0, latitude: 0, depth: 10 },
          }),
          { maxDepthKm: 50 },
        ),
      ).toBe(true);
    });

    it("delivers when depth exactly equals the ceiling (boundary, <=)", () => {
      expect(
        matchesFilter(
          makeEarthquake({
            coordinates: { longitude: 0, latitude: 0, depth: 50 },
          }),
          { maxDepthKm: 50 },
        ),
      ).toBe(true);
    });

    it("rejects when depth exceeds the ceiling", () => {
      expect(
        matchesFilter(
          makeEarthquake({
            coordinates: { longitude: 0, latitude: 0, depth: 50.1 },
          }),
          { maxDepthKm: 50 },
        ),
      ).toBe(false);
    });

    it("treats maxDepthKm of 0 as a real bound, not unset", () => {
      expect(
        matchesFilter(
          makeEarthquake({
            coordinates: { longitude: 0, latitude: 0, depth: 0 },
          }),
          { maxDepthKm: 0 },
        ),
      ).toBe(true);
      expect(
        matchesFilter(
          makeEarthquake({
            coordinates: { longitude: 0, latitude: 0, depth: 1 },
          }),
          { maxDepthKm: 0 },
        ),
      ).toBe(false);
    });
  });

  describe("region (12.2)", () => {
    it("delivers when the earthquake is inside the region", () => {
      expect(
        matchesFilter(
          makeEarthquake({
            coordinates: { ...REGION_INTERIOR.europe, depth: 10 },
          }),
          { region: "europe" },
        ),
      ).toBe(true);
    });

    it("rejects when the earthquake is outside the region", () => {
      expect(
        matchesFilter(
          makeEarthquake({
            coordinates: { ...REGION_INTERIOR.africa, depth: 10 },
          }),
          { region: "europe" },
        ),
      ).toBe(false);
    });
  });

  describe("combined dimensions (logical AND)", () => {
    const filter: SubscriptionParams = {
      minMagnitude: 4.0,
      maxDepthKm: 50,
      region: "americas",
    };

    it("delivers only when every dimension is satisfied", () => {
      expect(
        matchesFilter(
          makeEarthquake({
            magnitude: 5.0,
            coordinates: { ...REGION_INTERIOR.americas, depth: 20 },
          }),
          filter,
        ),
      ).toBe(true);
    });

    it("rejects when magnitude passes but region fails", () => {
      expect(
        matchesFilter(
          makeEarthquake({
            magnitude: 5.0,
            coordinates: { ...REGION_INTERIOR.asia, depth: 20 },
          }),
          filter,
        ),
      ).toBe(false);
    });

    it("rejects when region and magnitude pass but depth fails", () => {
      expect(
        matchesFilter(
          makeEarthquake({
            magnitude: 5.0,
            coordinates: { ...REGION_INTERIOR.americas, depth: 200 },
          }),
          filter,
        ),
      ).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// matchingSubscriptions / computeDeliveries — iteration & isolation
// ---------------------------------------------------------------------------

describe("matchingSubscriptions", () => {
  it("returns only active subscriptions whose filter matches", () => {
    const eq = makeEarthquake({ magnitude: 5.0 });
    const subs = [
      makeSubscription("a", { minMagnitude: 4.0 }), // match
      makeSubscription("b", { minMagnitude: 6.0 }), // magnitude too low
      makeSubscription("c", undefined), // no filter -> match
    ];
    expect(
      matchingSubscriptions(eq, subs).map((s) => s.subscriptionId),
    ).toEqual(["a", "c"]);
  });

  it("skips non-active subscriptions even when their filter would match", () => {
    const eq = makeEarthquake({ magnitude: 5.0 });
    const subs = [
      makeSubscription("expired", { minMagnitude: 4.0 }, "expired"),
      makeSubscription("failed", undefined, "failed"),
      makeSubscription("active", { minMagnitude: 4.0 }, "active"),
    ];
    expect(
      matchingSubscriptions(eq, subs).map((s) => s.subscriptionId),
    ).toEqual(["active"]);
  });
});

describe("computeDeliveries", () => {
  it("produces a delivery per (earthquake, matching subscription) pair (1.2)", () => {
    const quakes = [
      makeEarthquake({ earthquakeId: "q1", magnitude: 5.0 }),
      makeEarthquake({ earthquakeId: "q2", magnitude: 3.0 }),
    ];
    const subs = [
      makeSubscription("low", { minMagnitude: 2.5 }), // both quakes
      makeSubscription("high", { minMagnitude: 4.5 }), // only q1
    ];

    const pairs = computeDeliveries(quakes, subs).map(
      (d: EarthquakeDelivery) =>
        `${d.earthquake.earthquakeId}->${d.subscription.subscriptionId}`,
    );
    // Earthquake order preserved, then subscription order within each quake.
    expect(pairs).toEqual(["q1->low", "q1->high", "q2->low"]);
  });

  it("isolates subscriptions: one non-match does not affect another (1.5)", () => {
    const quake = makeEarthquake({
      earthquakeId: "q1",
      magnitude: 5.0,
      coordinates: { ...REGION_INTERIOR.americas, depth: 10 },
    });
    const subs = [
      makeSubscription("wrong-region", { region: "asia" }), // non-match
      makeSubscription("right-region", { region: "americas" }), // match
    ];

    const deliveries = computeDeliveries([quake], subs);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].subscription.subscriptionId).toBe("right-region");
  });

  it("returns no deliveries when there are no subscriptions", () => {
    expect(computeDeliveries([makeEarthquake()], [])).toEqual([]);
  });

  it("returns no deliveries when there are no earthquakes", () => {
    expect(computeDeliveries([], [makeSubscription("a")])).toEqual([]);
  });
});
