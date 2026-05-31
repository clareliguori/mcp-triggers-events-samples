/**
 * Per-subscription earthquake filtering for MCP Server 1 (task 6.3).
 *
 * Once {@link detectNewEarthquakes} (poller.ts, task 6.1) has determined which
 * earthquakes are new this poll cycle, this module decides — independently for
 * each active webhook subscription — which of those earthquakes should be
 * delivered to that subscription. Webhook delivery itself (signing + HTTP POST)
 * lives in the handler (task 6.5); this module is pure, deterministic, and
 * side-effect free so it can be unit- and property-tested with arbitrary inputs
 * (task 6.4).
 *
 * Filter semantics (design "Per-Subscription Earthquake Filtering",
 * Requirements 12.1-12.4):
 * - 12.1 `minMagnitude`: deliver only when `magnitude >= minMagnitude`.
 * - 12.2 `region`: deliver only when the earthquake's coordinates fall inside
 *   the region's bounding box (see {@link REGION_BOUNDS}).
 * - 12.3 `maxDepthKm`: deliver only when `depth <= maxDepthKm`.
 * - 12.4 no filter params set: deliver ALL earthquakes.
 *
 * Each filter dimension is OPTIONAL and independent; when a dimension is unset
 * (`undefined`) it does not constrain delivery. An earthquake is delivered to a
 * subscription only when it satisfies EVERY set dimension (logical AND).
 *
 * Because every decision is a pure function of `(earthquake, filterParams)`,
 * a non-match for one subscription can never influence another subscription's
 * decision (Requirement 1.5); {@link computeDeliveries} simply evaluates each
 * (earthquake, subscription) pair on its own.
 */

import type {
  EarthquakeDetectedData,
  Region,
  SubscriptionParams,
  WebhookSubscription,
} from "@mcp-events/shared";

// ---------------------------------------------------------------------------
// Region bounding boxes
// ---------------------------------------------------------------------------

/**
 * Axis-aligned latitude/longitude bounding box for a region, in decimal
 * degrees. Latitude is always `[latMin, latMax]` with `latMin <= latMax`.
 *
 * Longitude wraps at the antimeridian (+/-180 deg). A box that does NOT cross
 * the antimeridian has `lonMin <= lonMax` and matches `lonMin <= lon <= lonMax`.
 * A box that DOES cross it (the Pacific) has `lonMin > lonMax` and matches
 * `lon >= lonMin || lon <= lonMax`. {@link isInRegion} handles both cases.
 */
export interface RegionBounds {
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
}

/**
 * Approximate bounding boxes for each {@link Region} in the shared region enum
 * (`pacific`, `americas`, `europe`, `asia`, `africa`).
 *
 * These are intentionally coarse, demo-grade continental/oceanic boxes — the
 * goal is a clear, deterministic geographic filter, not survey-grade polygons.
 * The boxes overlap (e.g. the Pacific Ring of Fire shares longitudes with both
 * the Americas and Asia), which is expected: a region filter answers "is this
 * quake plausibly in the area I care about", and an earthquake can legitimately
 * satisfy more than one region.
 *
 * `pacific` crosses the antimeridian, so its `lonMin` (120 deg E) is greater
 * than its `lonMax` (-70 deg ~ 70 deg W); see {@link isInRegion}.
 */
export const REGION_BOUNDS: Record<Region, RegionBounds> = {
  // Pacific basin / Ring of Fire: wraps across the date line from the western
  // Pacific (Japan, Indonesia, NZ) eastward to the Americas' west coast.
  pacific: { latMin: -60, latMax: 65, lonMin: 120, lonMax: -70 },
  // North + South America.
  americas: { latMin: -56, latMax: 72, lonMin: -170, lonMax: -34 },
  // Europe (incl. the Mediterranean / Caucasus margin).
  europe: { latMin: 36, latMax: 72, lonMin: -25, lonMax: 45 },
  // Asia (Middle East through the Russian Far East).
  asia: { latMin: 5, latMax: 80, lonMin: 40, lonMax: 180 },
  // Africa.
  africa: { latMin: -35, latMax: 37, lonMin: -18, lonMax: 52 },
};

/**
 * Normalize a longitude in decimal degrees to the half-open range
 * `[-180, 180)`. USGS coordinates are already in this range, but normalizing
 * keeps the antimeridian-wrap comparison in {@link isInRegion} robust against
 * out-of-range inputs (e.g. arbitrary values from property tests).
 */
export function normalizeLongitude(longitude: number): number {
  // ((x + 180) mod 360 + 360) mod 360 - 180  →  always in [-180, 180).
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

/**
 * Whether the given coordinates fall within `region`'s bounding box.
 *
 * Latitude must lie in `[latMin, latMax]` (inclusive). Longitude is normalized
 * to `[-180, 180)` and then tested against the box, handling the Pacific's
 * antimeridian-crossing box (`lonMin > lonMax`) by matching either side of the
 * date line.
 */
export function isInRegion(
  coordinates: EarthquakeDetectedData["coordinates"],
  region: Region,
): boolean {
  const bounds = REGION_BOUNDS[region];
  const { latitude } = coordinates;
  const longitude = normalizeLongitude(coordinates.longitude);

  if (latitude < bounds.latMin || latitude > bounds.latMax) {
    return false;
  }

  return bounds.lonMin <= bounds.lonMax
    ? longitude >= bounds.lonMin && longitude <= bounds.lonMax
    : // Antimeridian-crossing box: inside if on either side of the date line.
      longitude >= bounds.lonMin || longitude <= bounds.lonMax;
}

// ---------------------------------------------------------------------------
// Single (earthquake, filter) delivery decision
// ---------------------------------------------------------------------------

/**
 * Decide whether a single earthquake should be delivered to a subscription with
 * the given filter parameters (Requirements 12.1-12.4).
 *
 * Returns `true` when the earthquake satisfies every filter dimension that is
 * set. An absent (`undefined`) `filter`, or a filter whose every field is
 * `undefined`, matches all earthquakes (Requirement 12.4).
 *
 * Note the use of explicit `!== undefined` guards rather than truthiness:
 * `minMagnitude: 0` and `maxDepthKm: 0` are meaningful bounds, not "unset".
 */
export function matchesFilter(
  earthquake: EarthquakeDetectedData,
  filter?: SubscriptionParams,
): boolean {
  if (!filter) {
    return true;
  }

  // 12.1 — magnitude floor.
  if (
    filter.minMagnitude !== undefined &&
    earthquake.magnitude < filter.minMagnitude
  ) {
    return false;
  }

  // 12.3 — depth ceiling.
  if (
    filter.maxDepthKm !== undefined &&
    earthquake.coordinates.depth > filter.maxDepthKm
  ) {
    return false;
  }

  // 12.2 — geographic region.
  if (
    filter.region !== undefined &&
    !isInRegion(earthquake.coordinates, filter.region)
  ) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Iterate active subscriptions for each new earthquake
// ---------------------------------------------------------------------------

/** Whether a subscription is currently eligible to receive deliveries. */
function isActive(subscription: WebhookSubscription): boolean {
  return subscription.status === "active";
}

/**
 * A single (subscription, earthquake) pair that passed the subscription's
 * filter and should therefore be delivered as an `earthquake.detected` event by
 * the handler (task 6.5).
 */
export interface EarthquakeDelivery {
  subscription: WebhookSubscription;
  earthquake: EarthquakeDetectedData;
}

/**
 * Return the active subscriptions whose filter the earthquake satisfies.
 *
 * Iterates over every supplied subscription, skips non-active ones, and keeps
 * those whose {@link WebhookSubscription.filterParams} match the earthquake.
 * Each subscription is evaluated independently, so one subscription's non-match
 * never affects another's (Requirement 1.5).
 */
export function matchingSubscriptions(
  earthquake: EarthquakeDetectedData,
  subscriptions: readonly WebhookSubscription[],
): WebhookSubscription[] {
  return subscriptions.filter(
    (subscription) =>
      isActive(subscription) &&
      matchesFilter(earthquake, subscription.filterParams),
  );
}

/**
 * Produce the full set of (subscription, earthquake) deliveries for a batch of
 * newly detected earthquakes across all active subscriptions (Requirement 1.2).
 *
 * For each earthquake (in input order) this iterates over every active
 * subscription and emits a {@link EarthquakeDelivery} for each filter match.
 * The result preserves earthquake order, then subscription order, giving a
 * deterministic delivery sequence the handler can iterate over.
 *
 * Pure and side-effect free: it neither signs nor sends anything, so it is the
 * unit of logic exercised by the per-customer filtering property test
 * (task 6.4).
 */
export function computeDeliveries(
  earthquakes: readonly EarthquakeDetectedData[],
  subscriptions: readonly WebhookSubscription[],
): EarthquakeDelivery[] {
  const deliveries: EarthquakeDelivery[] = [];
  for (const earthquake of earthquakes) {
    for (const subscription of matchingSubscriptions(
      earthquake,
      subscriptions,
    )) {
      deliveries.push({ subscription, earthquake });
    }
  }
  return deliveries;
}
