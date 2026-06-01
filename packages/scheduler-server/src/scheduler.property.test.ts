/**
 * Property 13: Cron Schedule Evaluation.
 *
 * Exercises the pure scheduler logic (task 7.1) with fast-check. For any
 * timestamp and cron expression, MCP Server 2 must fire a briefing trigger if
 * and only if the cron expression matches the current time (UTC, minute
 * granular); a non-matching schedule must not produce a trigger
 * (Requirements 2.1, 2.3).
 *
 * The expected decision is computed by an INDEPENDENT oracle. Rather than
 * reusing {@link parseCron}/{@link matchesCron} (the code under test), each cron
 * field is GENERATED together with the explicit integer set it denotes — the
 * generator computes that set itself, atom by atom (`*`, single, range,
 * `*\/step`, `start/step`, comma lists), normalizing day-of-week `7` onto `0`.
 * The oracle then composes the per-field membership tests directly from the
 * Vixie cron rules: minute AND hour AND month must match, and the day match is
 * `dom OR dow` when BOTH day fields are restricted (the rendered field text is
 * not exactly `*`) and `dom AND dow` otherwise. So the value sets and the
 * boolean composition are derived from the specification independently of the
 * implementation, and asserted equal to {@link cronMatchesAt} /
 * {@link dueSubscriptions}.
 *
 * Two framings are checked:
 *
 *   A. Property 13 proper (2.1) — a single `(expression, date)` decision from
 *      {@link cronMatchesAt} equals the oracle EXACTLY. Dates are a mix of
 *      uniformly random instants and instants deliberately ALIGNED to the
 *      generated schedule's value sets, so both `true` and `false` outcomes get
 *      good coverage instead of "almost always false".
 *
 *   B. Customer isolation (2.3) — over a whole set of subscriptions evaluated at
 *      one `now`, {@link dueSubscriptions} returns EXACTLY the active
 *      `briefing.trigger` subscriptions whose schedule matches (input order
 *      preserved), and each subscription's membership depends ONLY on that
 *      subscription evaluated alone, never on its neighbours (a non-match or a
 *      different event type never affects another customer).
 *
 * **Validates: Requirements 2.1, 2.3**
 */

import type { WebhookSubscription } from "@mcp-events/shared";
import {
  EVENT_NAME_BRIEFING_TRIGGER,
  EVENT_NAME_EARTHQUAKE_DETECTED,
} from "@mcp-events/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { cronMatchesAt, dueSubscriptions } from "./scheduler.js";

/** Per-property run count. Spec floor is 100 random inputs per property. */
const NUM_RUNS = 100;

/** Generated date range (UTC). Wide enough to span months and weekdays. */
const MIN_DATE = new Date(Date.UTC(2000, 0, 1, 0, 0, 0, 0));
const MAX_DATE = new Date(Date.UTC(2050, 11, 31, 23, 59, 0, 0));

// ---------------------------------------------------------------------------
// Independent field model (value sets computed by the generator, not the code
// under test)
// ---------------------------------------------------------------------------

/**
 * One generated cron field: the rendered `text` (e.g. `"*\/15"`, `"5,9-11"`)
 * and the explicit set of integers it denotes. `text === "*"` is the sole
 * "unrestricted" form, which is what selects the OR-vs-AND day rule in the
 * oracle — mirroring `parseCron`'s `domRestricted`/`dowRestricted` flags.
 */
interface CronField {
  readonly text: string;
  readonly values: ReadonlySet<number>;
}

type Normalize = (value: number) => number;

/** Fold the day-of-week `7` (Sunday) onto the canonical `0`. */
const normalizeDayOfWeek: Normalize = (value) => (value === 7 ? 0 : value);

/** Inclusive `[lo, hi]` expanded and normalized. */
function rangeValues(lo: number, hi: number, normalize: Normalize): number[] {
  const values: number[] = [];
  for (let value = lo; value <= hi; value++) {
    values.push(normalize(value));
  }
  return values;
}

/** `start, start+step, ...` up to `max` (inclusive), normalized. */
function stepValues(
  start: number,
  max: number,
  step: number,
  normalize: Normalize,
): number[] {
  const values: number[] = [];
  for (let value = start; value <= max; value += step) {
    values.push(normalize(value));
  }
  return values;
}

/**
 * An arbitrary single cron atom for a field bounded by `[min, max]`, paired with
 * the integer set it denotes (computed here, independently of `expandField`).
 * Ranges are always emitted low-to-high and steps always positive, so every
 * generated expression parses (the iff property needs a non-throwing parse).
 */
function atomArb(
  min: number,
  max: number,
  normalize: Normalize,
): fc.Arbitrary<{ text: string; values: number[] }> {
  const wildcard = fc.constant({
    text: "*",
    values: rangeValues(min, max, normalize),
  });

  const single = fc
    .integer({ min, max })
    .map((n) => ({ text: `${n}`, values: [normalize(n)] }));

  const range = fc
    .tuple(fc.integer({ min, max }), fc.integer({ min, max }))
    .map(([a, b]) => {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      return { text: `${lo}-${hi}`, values: rangeValues(lo, hi, normalize) };
    });

  const stepFromWildcard = fc.integer({ min: 1, max }).map((step) => ({
    text: `*/${step}`,
    values: stepValues(min, max, step, normalize),
  }));

  const stepFromStart = fc
    .tuple(fc.integer({ min, max }), fc.integer({ min: 1, max }))
    .map(([start, step]) => ({
      text: `${start}/${step}`,
      values: stepValues(start, max, step, normalize),
    }));

  return fc.oneof(wildcard, single, range, stepFromWildcard, stepFromStart);
}

/**
 * An arbitrary cron field: a comma-separated list of 1-4 atoms. The field is
 * "unrestricted" only when it is exactly `"*"` (a lone wildcard atom); any comma
 * list — even `"*,*"` — renders as restricted, exactly as `parseCron` treats
 * `dayOfMonth !== "*"` / `dayOfWeek !== "*"`.
 */
function fieldArb(
  min: number,
  max: number,
  normalize: Normalize = (value) => value,
): fc.Arbitrary<CronField> {
  return fc
    .array(atomArb(min, max, normalize), { minLength: 1, maxLength: 4 })
    .map((atoms) => ({
      text: atoms.map((atom) => atom.text).join(","),
      values: new Set(atoms.flatMap((atom) => atom.values)),
    }));
}

/** The five fields of a generated expression, plus its rendered string. */
interface CronSpec {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
}

const cronSpecArb: fc.Arbitrary<{ spec: CronSpec; expression: string }> = fc
  .record({
    minute: fieldArb(0, 59),
    hour: fieldArb(0, 23),
    dayOfMonth: fieldArb(1, 31),
    month: fieldArb(1, 12),
    dayOfWeek: fieldArb(0, 7, normalizeDayOfWeek),
  })
  .map((spec) => ({
    spec,
    expression: [
      spec.minute.text,
      spec.hour.text,
      spec.dayOfMonth.text,
      spec.month.text,
      spec.dayOfWeek.text,
    ].join(" "),
  }));

// ---------------------------------------------------------------------------
// Independent oracle (Vixie cron rules, written straight from the spec)
// ---------------------------------------------------------------------------

/**
 * Whether the generated schedule fires at `date`, computed from the generated
 * value sets and the Vixie day rule directly. Minute, hour, and month must each
 * match; the day matches via OR when BOTH day fields are restricted and via AND
 * otherwise. Evaluation reads the UTC components, matching {@link matchesCron}.
 */
function expectedMatch(spec: CronSpec, date: Date): boolean {
  if (!spec.minute.values.has(date.getUTCMinutes())) {
    return false;
  }
  if (!spec.hour.values.has(date.getUTCHours())) {
    return false;
  }
  if (!spec.month.values.has(date.getUTCMonth() + 1)) {
    return false;
  }

  const domMatch = spec.dayOfMonth.values.has(date.getUTCDate());
  const dowMatch = spec.dayOfWeek.values.has(date.getUTCDay());
  const domRestricted = spec.dayOfMonth.text !== "*";
  const dowRestricted = spec.dayOfWeek.text !== "*";

  return domRestricted && dowRestricted
    ? domMatch || dowMatch
    : domMatch && dowMatch;
}

// ---------------------------------------------------------------------------
// Date generators
// ---------------------------------------------------------------------------

/** A uniformly random UTC instant in range (never an Invalid Date). */
const randomDateArb = fc.date({
  min: MIN_DATE,
  max: MAX_DATE,
  noInvalidDate: true,
});

/**
 * A UTC instant deliberately ALIGNED to one schedule's value sets: minute,
 * hour, month, and day are each drawn from the corresponding field's set, so
 * the schedule matches far more often than random sampling manages. Day-of-week
 * is left to fall out of the calendar (it cannot be forced alongside a chosen
 * day-of-month), so both the OR and AND day branches still see hits and misses.
 * An impossible day/month combination (e.g. the 31st of a short month) simply
 * rolls over; the oracle and the implementation both read the resulting instant.
 */
function alignedDateArb(spec: CronSpec): fc.Arbitrary<Date> {
  return fc
    .record({
      year: fc.integer({ min: 2000, max: 2050 }),
      minute: fc.constantFrom(...spec.minute.values),
      hour: fc.constantFrom(...spec.hour.values),
      month: fc.constantFrom(...spec.month.values),
      day: fc.constantFrom(...spec.dayOfMonth.values),
    })
    .map(
      ({ year, minute, hour, month, day }) =>
        new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0)),
    );
}

/** A `(expression, spec, date)` triple mixing random and schedule-aligned dates. */
const cronAndDateArb = cronSpecArb.chain(({ spec, expression }) =>
  fc
    .oneof(randomDateArb, alignedDateArb(spec))
    .map((date) => ({ spec, expression, date })),
);

// ---------------------------------------------------------------------------
// Subscription generators (for the per-customer isolation property)
// ---------------------------------------------------------------------------

/** Build an active-by-default briefing subscription with the given schedule. */
function makeSubscription(
  subscriptionId: string,
  schedule: string | undefined,
  status: WebhookSubscription["status"],
  eventName: WebhookSubscription["eventName"],
): WebhookSubscription {
  return {
    subscriptionId,
    customerId: `customer-${subscriptionId}`,
    serverEndpoint: "https://scheduler-mcp.example.test/mcp",
    eventName,
    callbackUrl: "https://webhook.example.test/webhook",
    encryptedSecret: "ciphertext",
    schedule,
    createdAt: "2024-01-01T00:00:00.000Z",
    expiresAt: "2024-01-01T00:30:00.000Z",
    lastRefreshedAt: "2024-01-01T00:00:00.000Z",
    status,
  };
}

/** The variable parts of one generated subscription. */
interface SubscriptionConfig {
  readonly spec: CronSpec;
  readonly schedule: string | undefined;
  readonly status: WebhookSubscription["status"];
  readonly eventName: WebhookSubscription["eventName"];
}

/**
 * A subscription config: a generated schedule that is sometimes dropped
 * (`undefined`), an arbitrary lifecycle status, and either event name — so the
 * non-active, scheduleless, and non-briefing skip paths of `isSubscriptionDue`
 * are all exercised alongside the cron match itself.
 */
const subscriptionConfigArb: fc.Arbitrary<SubscriptionConfig> = fc
  .record({
    cron: cronSpecArb,
    hasSchedule: fc.boolean(),
    status: fc.constantFrom<WebhookSubscription["status"]>(
      "active",
      "expired",
      "failed",
    ),
    eventName: fc.constantFrom<WebhookSubscription["eventName"]>(
      EVENT_NAME_BRIEFING_TRIGGER,
      EVENT_NAME_EARTHQUAKE_DETECTED,
    ),
  })
  .map(({ cron, hasSchedule, status, eventName }) => ({
    spec: cron.spec,
    schedule: hasSchedule ? cron.expression : undefined,
    status,
    eventName,
  }));

const subscriptionConfigsArb = fc.array(subscriptionConfigArb, {
  maxLength: 8,
});

/**
 * The `now` against which a whole subscription set is evaluated. Mixes uniformly
 * random instants with "round" instants (minute on a 15-boundary, day within
 * the first 28 so it is valid for every month) so some subscriptions are
 * actually due on many runs, not just on rare alignments.
 */
const nowArb = fc.oneof(
  randomDateArb,
  fc
    .record({
      year: fc.integer({ min: 2000, max: 2050 }),
      month: fc.integer({ min: 0, max: 11 }),
      day: fc.integer({ min: 1, max: 28 }),
      hour: fc.integer({ min: 0, max: 23 }),
      minute: fc.constantFrom(0, 15, 30, 45),
    })
    .map(
      ({ year, month, day, hour, minute }) =>
        new Date(Date.UTC(year, month, day, hour, minute, 0, 0)),
    ),
);

/** Whether one generated subscription is expected to be due at `now`. */
function expectedDue(config: SubscriptionConfig, now: Date): boolean {
  return (
    config.status === "active" &&
    config.eventName === EVENT_NAME_BRIEFING_TRIGGER &&
    config.schedule !== undefined &&
    expectedMatch(config.spec, now)
  );
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("Property 13: Cron Schedule Evaluation", () => {
  it("2.1: cronMatchesAt fires iff the cron matches the current time (independent oracle)", () => {
    fc.assert(
      fc.property(cronAndDateArb, ({ expression, spec, date }) => {
        expect(cronMatchesAt(expression, date)).toBe(expectedMatch(spec, date));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("2.3: dueSubscriptions selects exactly the matching active subscriptions, isolating each customer", () => {
    fc.assert(
      fc.property(subscriptionConfigsArb, nowArb, (configs, now) => {
        const subscriptions = configs.map((config, index) =>
          makeSubscription(
            `sub-${index}`,
            config.schedule,
            config.status,
            config.eventName,
          ),
        );

        const due = dueSubscriptions(subscriptions, now);

        // Exactness (2.1/2.3): the due set equals the per-subscription oracle,
        // preserving input order for deterministic delivery.
        const oracle = subscriptions.filter((_subscription, index) =>
          expectedDue(configs[index], now),
        );
        expect(due).toEqual(oracle);

        // Isolation (2.3): a subscription's membership in the whole-set result
        // depends ONLY on that subscription evaluated alone — a neighbour's
        // non-match (or different event type / status) never changes it.
        const dueIds = new Set(due.map((s) => s.subscriptionId));
        for (const subscription of subscriptions) {
          const alone = dueSubscriptions([subscription], now);
          expect(dueIds.has(subscription.subscriptionId)).toBe(
            alone.length === 1,
          );
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
