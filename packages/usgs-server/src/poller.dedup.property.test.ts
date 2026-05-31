/**
 * Property 3: Earthquake Deduplication (Cursor Integrity).
 *
 * Exercises the cursor-based dedup contract of the USGS poller (task 6.1) with
 * fast-check by simulating the production poll loop across many cycles:
 *
 *     read cursor -> findNewEarthquakes -> emit -> mergeLastSeenIds (commit)
 *
 * using the real pure functions {@link findNewEarthquakes} and
 * {@link mergeLastSeenIds} (the same logic {@link commitCursor} persists). The
 * loop is driven purely in memory so the property is deterministic and fast,
 * with no DynamoDB or network dependency.
 *
 * Two complementary framings of the same property are checked:
 *
 *   A. Arbitrary poll sequences over a bounded distinct universe. Each poll is
 *      an arbitrary (overlapping) subset of a fixed set of earthquakes whose
 *      size stays within the rolling window ({@link USGS_CURSOR_MAX_IDS}). No ID
 *      is ever evicted, so the at-most-once guarantee must hold for ANY overlap
 *      pattern, and after EVERY cycle the cursor must contain exactly the set of
 *      IDs emitted so far ("the cursor contains all previously emitted IDs").
 *
 *   B. Realistic sliding-window feed with a LARGE distinct universe. The feed
 *      shows a moving window of `feedWindow <= 200` earthquakes that advances by
 *      `stride` each poll, so the TOTAL number of distinct earthquakes across
 *      the run far exceeds the 200-entry cursor bound while overlapping
 *      consecutive feeds. This validates the design's claim that a 200-ID window
 *      "covers everything in the feed" (the 2.5_day feed polled every 5 min):
 *      each earthquake is still emitted exactly once even though the universe is
 *      much larger than the window. (If the feed window exceeded 200, an evicted
 *      ID could reappear and be re-emitted — so the bound is what makes this
 *      non-trivially true.)
 *
 * **Validates: Requirements 1.1, 1.4, 1.6**
 */

import type { EarthquakeDetectedData } from "@mcp-events/shared";
import { USGS_CURSOR_MAX_IDS } from "@mcp-events/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { findNewEarthquakes, mergeLastSeenIds } from "./poller.js";

/** Per-property run count. fast-check defaults to 100; we set it explicitly. */
const NUM_RUNS = 200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a structurally valid {@link EarthquakeDetectedData}. Only `earthquakeId`
 * matters for deduplication, but generating the full shape keeps the simulation
 * faithful to what `extractEarthquakes` would feed the dedup logic. `time` is
 * derived from `index` so emission order is stable and meaningful.
 */
function makeEarthquake(id: string, index: number): EarthquakeDetectedData {
  return {
    earthquakeId: id,
    magnitude: 4.2,
    place: `synthetic event ${index}`,
    coordinates: { longitude: -117.6, latitude: 35.6, depth: 8.3 },
    time: new Date(1_700_000_000_000 + index * 60_000).toISOString(),
    tsunami: false,
    felt: null,
    alert: null,
    url: "",
  };
}

/**
 * Run the production poll loop over a sequence of polls and return, for every
 * earthquake ID that appeared in any poll, the number of times it was emitted,
 * plus the final cursor window.
 *
 * When `assertCursorHoldsAllEmitted` is set (only sound when the distinct
 * universe stays within {@link USGS_CURSOR_MAX_IDS}, so nothing is ever
 * evicted), it asserts the cursor-integrity invariant after EVERY cycle: the
 * cursor row holds exactly the set of IDs emitted so far.
 */
function simulatePolls(
  polls: readonly EarthquakeDetectedData[][],
  assertCursorHoldsAllEmitted = false,
): {
  emitCounts: Map<string, number>;
  appeared: Set<string>;
  finalCursor: string[];
} {
  let lastSeenIds: string[] = [];
  const emitCounts = new Map<string, number>();
  const appeared = new Set<string>();
  const emittedSoFar = new Set<string>();

  for (const poll of polls) {
    for (const quake of poll) {
      appeared.add(quake.earthquakeId);
    }

    // read cursor -> find new -> emit
    const newEarthquakes = findNewEarthquakes(poll, lastSeenIds);
    for (const quake of newEarthquakes) {
      emitCounts.set(
        quake.earthquakeId,
        (emitCounts.get(quake.earthquakeId) ?? 0) + 1,
      );
      emittedSoFar.add(quake.earthquakeId);
    }

    // commit cursor (fold emitted IDs into the rolling window)
    lastSeenIds = mergeLastSeenIds(
      lastSeenIds,
      newEarthquakes.map((q) => q.earthquakeId),
    );

    // Cursor integrity (Req 1.4): while the distinct universe stays within the
    // window bound, the cursor row holds EXACTLY the IDs emitted so far.
    if (assertCursorHoldsAllEmitted) {
      expect(new Set(lastSeenIds)).toEqual(emittedSoFar);
    }
  }

  return { emitCounts, appeared, finalCursor: lastSeenIds };
}

// ---------------------------------------------------------------------------
// Generators — Framing A: arbitrary polls over a bounded distinct universe
// ---------------------------------------------------------------------------

/** A USGS-style earthquake ID, e.g. "us7000n123". */
const usgsIdArb: fc.Arbitrary<string> = fc
  .string({ minLength: 4, maxLength: 12, unit: "grapheme-ascii" })
  .map((s) => `us${s}`);

/**
 * A universe of distinct earthquakes (size 1..200, i.e. within the cursor
 * window) paired with an arbitrary sequence of overlapping polls. Each poll is a
 * non-empty subset of the universe; fast-check naturally produces heavy overlap
 * between polls (the same IDs reappearing across cycles), which is exactly the
 * "overlapping IDs" the property targets.
 */
const boundedUniverseScenarioArb = fc
  .uniqueArray(usgsIdArb, { minLength: 1, maxLength: USGS_CURSOR_MAX_IDS })
  .chain((ids) => {
    const universe = ids.map((id, i) => makeEarthquake(id, i));
    // A poll is a non-empty subset of the universe, chosen by index so each
    // selection maps to a concrete earthquake (no possibly-undefined lookup).
    const pollArb = fc
      .uniqueArray(fc.nat({ max: universe.length - 1 }), {
        minLength: 1,
        maxLength: universe.length,
      })
      .map((indices) => indices.map((i) => universe[i]));
    return fc.record({
      universeSize: fc.constant(universe.length),
      polls: fc.array(pollArb, { minLength: 1, maxLength: 20 }),
    });
  });

// ---------------------------------------------------------------------------
// Generators — Framing B: realistic sliding-window feed, large universe
// ---------------------------------------------------------------------------

/**
 * A sliding-window feed scenario. `feedWindow` events are visible per poll
 * (bounded to the cursor window), the window advances by `stride <= feedWindow`
 * each poll (guaranteeing overlap or, at the boundary, contiguity with no gaps),
 * and there are `numPolls` polls. The total distinct universe is
 * `(numPolls - 1) * stride + feedWindow`, which routinely exceeds the 200-entry
 * cursor bound.
 */
const slidingWindowScenarioArb = fc
  .record({
    feedWindow: fc.integer({ min: 1, max: USGS_CURSOR_MAX_IDS }),
    numPolls: fc.integer({ min: 1, max: 12 }),
  })
  .chain(({ feedWindow, numPolls }) =>
    fc.record({
      feedWindow: fc.constant(feedWindow),
      numPolls: fc.constant(numPolls),
      // stride in [1, feedWindow]: progress each poll, never leaving a gap.
      stride: fc.integer({ min: 1, max: feedWindow }),
    }),
  );

/** Materialize a sliding-window scenario into concrete poll batches. */
function buildSlidingWindowPolls(scenario: {
  feedWindow: number;
  numPolls: number;
  stride: number;
}): { polls: EarthquakeDetectedData[][]; total: number } {
  const { feedWindow, numPolls, stride } = scenario;
  const total = (numPolls - 1) * stride + feedWindow;
  const universe = Array.from({ length: total }, (_, k) =>
    makeEarthquake(`eq-${k}`, k),
  );
  const polls: EarthquakeDetectedData[][] = [];
  for (let i = 0; i < numPolls; i++) {
    const start = i * stride;
    polls.push(universe.slice(start, start + feedWindow));
  }
  return { polls, total };
}

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe("Property 3: Earthquake Deduplication (Cursor Integrity)", () => {
  it("1.1/1.4/1.6: emits each earthquake at most once across arbitrary overlapping polls", () => {
    fc.assert(
      fc.property(boundedUniverseScenarioArb, ({ polls }) => {
        const { emitCounts, appeared, finalCursor } = simulatePolls(
          polls,
          true,
        );

        // At most once (Req 1.6): no earthquake ID is ever emitted twice.
        for (const count of emitCounts.values()) {
          expect(count).toBeLessThanOrEqual(1);
        }

        // Completeness (Req 1.1): every earthquake that appeared in any poll is
        // emitted (exactly once), so dedup never silently drops a NEW event.
        for (const id of appeared) {
          expect(emitCounts.get(id)).toBe(1);
        }

        // Cursor integrity (Req 1.4): the final cursor holds every emitted ID.
        expect(new Set(finalCursor)).toEqual(appeared);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("1.1/1.4/1.6: a 200-ID window dedupes a feed whose total distinct events exceed the bound", () => {
    fc.assert(
      fc.property(slidingWindowScenarioArb, (scenario) => {
        const { polls, total } = buildSlidingWindowPolls(scenario);

        const { emitCounts } = simulatePolls(polls);

        // Every distinct earthquake in the moving feed is emitted EXACTLY once,
        // even when `total` far exceeds USGS_CURSOR_MAX_IDS, because the feed
        // window never exceeds the cursor window so no still-visible ID is
        // evicted and re-emitted (Req 1.6 + the rolling-window bound, Req 1.4).
        expect(emitCounts.size).toBe(total);
        for (let k = 0; k < total; k++) {
          expect(emitCounts.get(`eq-${k}`)).toBe(1);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
