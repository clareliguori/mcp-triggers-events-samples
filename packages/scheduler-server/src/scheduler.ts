/**
 * Cron schedule parsing and evaluation for MCP Server 2 (task 7.1).
 *
 * MCP Server 2 (the Message Scheduler) is woken by EventBridge once a minute.
 * On each tick it must decide — independently for each active webhook
 * subscription — whether that customer's cron schedule fires *now*, so it can
 * deliver a `briefing.trigger` event only to the customers who are due
 * (Requirements 2.1, 2.3). This module owns that decision: it parses a
 * subscription's cron expression and evaluates it against the current time.
 *
 * Webhook delivery itself (signing + HTTP POST) and loading subscriptions from
 * DynamoDB live in the handler (task 7.3); like `usgs-server/filter.ts`, this
 * module is pure, deterministic, and side-effect free so it can be unit- and
 * property-tested (task 7.2) with arbitrary times and expressions.
 *
 * Cron dialect (matches the shared `CRON_REGEX`, a 5-field
 * `minute hour day-of-month month day-of-week` expression):
 * - `*`            — every value in the field's range.
 * - `5`            — a single value.
 * - `1-5`          — an inclusive range.
 * - `*\/15`         — a step from the field minimum (`0,15,30,45` for minutes).
 * - `5/15`         — a step from an explicit start (`5,20,35,50` for minutes).
 * - `a,b,c`        — a comma-separated list of any of the above.
 *
 * Field ranges follow Vixie/cron conventions: minute `0-59`, hour `0-23`,
 * day-of-month `1-31`, month `1-12`, day-of-week `0-6` (Sunday = 0, with `7`
 * also accepted and normalized to `0`).
 *
 * Day-of-month / day-of-week semantics also follow Vixie cron: when BOTH fields
 * are restricted (neither is `*`), a date matches if EITHER field matches
 * (logical OR). When at most one is restricted, all fields must match (logical
 * AND). See {@link matchesCron}.
 *
 * Time zone: evaluation is in UTC. EventBridge and Lambda run in UTC and the
 * stored schedule carries no zone, so {@link matchesCron} reads the UTC
 * components of the supplied `Date`. Seconds and milliseconds are irrelevant —
 * matching is inherently minute-granular.
 */

import type { WebhookSubscription } from "@mcp-events/shared";
import { EVENT_NAME_BRIEFING_TRIGGER } from "@mcp-events/shared";

// ---------------------------------------------------------------------------
// Field definitions
// ---------------------------------------------------------------------------

/** The five cron fields, in positional order. */
export const CRON_FIELD_NAMES = [
  "minute",
  "hour",
  "dayOfMonth",
  "month",
  "dayOfWeek",
] as const;

export type CronFieldName = (typeof CRON_FIELD_NAMES)[number];

/** Inclusive `[min, max]` bound for each cron field (Vixie cron ranges). */
interface FieldBound {
  min: number;
  max: number;
}

/**
 * Per-field value bounds. Day-of-week tops out at `7` so the common "Sunday as
 * 7" form parses; {@link expandField} normalizes `7` back to `0`.
 */
const FIELD_BOUNDS: Record<CronFieldName, FieldBound> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dayOfWeek: { min: 0, max: 7 },
};

// ---------------------------------------------------------------------------
// Parsed representation
// ---------------------------------------------------------------------------

/**
 * A cron expression expanded into the explicit set of matching values for each
 * field. `domRestricted` / `dowRestricted` record whether the day-of-month and
 * day-of-week fields were anything other than `*`, which selects the OR-vs-AND
 * day-matching rule in {@link matchesCron}.
 */
export interface ParsedCron {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

// ---------------------------------------------------------------------------
// Field expansion
// ---------------------------------------------------------------------------

const STEP_FROM_WILDCARD = /^\*\/(\d+)$/;
const STEP_FROM_START = /^(\d+)\/(\d+)$/;
const RANGE = /^(\d+)-(\d+)$/;
const SINGLE = /^(\d+)$/;

/**
 * Expand one cron field (e.g. `"0,30"`, `"*\/15"`, `"1-5"`) into the explicit
 * set of integers it matches, validating every value against `[min, max]`.
 *
 * `normalize` is applied to each value before it is added (used to fold the
 * day-of-week `7` onto `0`). Throws {@link Error} on any structurally or
 * numerically invalid part so a misconfigured schedule surfaces rather than
 * silently matching nothing; callers that must tolerate bad data (the
 * per-subscription scan) catch and skip — see {@link dueSubscriptions}.
 */
export function expandField(
  field: string,
  min: number,
  max: number,
  normalize: (value: number) => number = (value) => value,
): Set<number> {
  const values = new Set<number>();
  const add = (value: number): void => {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(
        `cron value ${value} is out of range [${min}, ${max}] in field "${field}"`,
      );
    }
    values.add(normalize(value));
  };

  for (const part of field.split(",")) {
    if (part === "*") {
      for (let value = min; value <= max; value++) {
        add(value);
      }
      continue;
    }

    const wildcardStep = STEP_FROM_WILDCARD.exec(part);
    if (wildcardStep) {
      const step = Number(wildcardStep[1]);
      if (step <= 0) {
        throw new Error(`cron step must be positive in field "${field}"`);
      }
      for (let value = min; value <= max; value += step) {
        add(value);
      }
      continue;
    }

    const startStep = STEP_FROM_START.exec(part);
    if (startStep) {
      const start = Number(startStep[1]);
      const step = Number(startStep[2]);
      if (step <= 0) {
        throw new Error(`cron step must be positive in field "${field}"`);
      }
      if (start < min || start > max) {
        throw new Error(
          `cron start ${start} is out of range [${min}, ${max}] in field "${field}"`,
        );
      }
      for (let value = start; value <= max; value += step) {
        add(value);
      }
      continue;
    }

    const range = RANGE.exec(part);
    if (range) {
      const low = Number(range[1]);
      const high = Number(range[2]);
      if (low > high) {
        throw new Error(
          `cron range ${low}-${high} is inverted in field "${field}"`,
        );
      }
      for (let value = low; value <= high; value++) {
        add(value);
      }
      continue;
    }

    const single = SINGLE.exec(part);
    if (single) {
      add(Number(single[1]));
      continue;
    }

    throw new Error(`invalid cron field part "${part}" in field "${field}"`);
  }

  return values;
}

/** Fold the day-of-week `7` (Sunday) onto the canonical `0`. */
function normalizeDayOfWeek(value: number): number {
  return value === 7 ? 0 : value;
}

// ---------------------------------------------------------------------------
// Expression parsing
// ---------------------------------------------------------------------------

/**
 * Parse a 5-field cron expression into a {@link ParsedCron}.
 *
 * Splits on runs of whitespace, requires exactly five fields, and expands each
 * against its field bounds. Throws {@link Error} when the field count is wrong
 * or any field is invalid (see {@link expandField}).
 */
export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `cron expression must have 5 fields, got ${fields.length}: "${expression}"`,
    );
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;

  return {
    minutes: expandField(
      minute,
      FIELD_BOUNDS.minute.min,
      FIELD_BOUNDS.minute.max,
    ),
    hours: expandField(hour, FIELD_BOUNDS.hour.min, FIELD_BOUNDS.hour.max),
    daysOfMonth: expandField(
      dayOfMonth,
      FIELD_BOUNDS.dayOfMonth.min,
      FIELD_BOUNDS.dayOfMonth.max,
    ),
    months: expandField(month, FIELD_BOUNDS.month.min, FIELD_BOUNDS.month.max),
    daysOfWeek: expandField(
      dayOfWeek,
      FIELD_BOUNDS.dayOfWeek.min,
      FIELD_BOUNDS.dayOfWeek.max,
      normalizeDayOfWeek,
    ),
    domRestricted: dayOfMonth !== "*",
    dowRestricted: dayOfWeek !== "*",
  };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Whether a parsed cron expression fires at the given instant (UTC,
 * minute-granular).
 *
 * The minute, hour, and month fields must each match. The day match follows
 * Vixie cron: when BOTH day-of-month and day-of-week are restricted, the date
 * matches if EITHER matches; otherwise both must match (an unrestricted field
 * always matches because its value set spans the whole range).
 */
export function matchesCron(parsed: ParsedCron, date: Date): boolean {
  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const dayOfMonth = date.getUTCDate();
  const month = date.getUTCMonth() + 1;
  const dayOfWeek = date.getUTCDay();

  if (!parsed.minutes.has(minute)) {
    return false;
  }
  if (!parsed.hours.has(hour)) {
    return false;
  }
  if (!parsed.months.has(month)) {
    return false;
  }

  const domMatch = parsed.daysOfMonth.has(dayOfMonth);
  const dowMatch = parsed.daysOfWeek.has(dayOfWeek);
  const dayMatch =
    parsed.domRestricted && parsed.dowRestricted
      ? domMatch || dowMatch
      : domMatch && dowMatch;

  return dayMatch;
}

/**
 * Convenience: parse `expression` and evaluate it against `date` in one call.
 * Propagates parse errors from {@link parseCron}.
 */
export function cronMatchesAt(expression: string, date: Date): boolean {
  return matchesCron(parseCron(expression), date);
}

// ---------------------------------------------------------------------------
// Per-subscription due evaluation
// ---------------------------------------------------------------------------

/** Whether a subscription is currently eligible to receive a trigger. */
function isActive(subscription: WebhookSubscription): boolean {
  return subscription.status === "active";
}

/**
 * Whether a single briefing subscription is due to fire at `now`.
 *
 * Returns `false` (rather than throwing) for subscriptions that are not active,
 * are not `briefing.trigger` subscriptions, carry no schedule, or whose
 * schedule fails to parse. Isolating a bad or non-matching subscription here is
 * what lets {@link dueSubscriptions} skip one customer without affecting the
 * rest (Requirement 2.3).
 */
export function isSubscriptionDue(
  subscription: WebhookSubscription,
  now: Date,
): boolean {
  if (!isActive(subscription)) {
    return false;
  }
  if (subscription.eventName !== EVENT_NAME_BRIEFING_TRIGGER) {
    return false;
  }
  if (subscription.schedule === undefined) {
    return false;
  }

  try {
    return cronMatchesAt(subscription.schedule, now);
  } catch (error) {
    // A schedule that passed the structural CRON_REGEX at write time can still
    // be numerically out of range (e.g. minute 99). Skip the offending
    // subscription rather than failing the whole tick (Requirement 2.3).
    console.warn("Skipping subscription with unparseable cron schedule", {
      subscriptionId: subscription.subscriptionId,
      schedule: subscription.schedule,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Evaluate every subscription's cron schedule against `now` and return the
 * active `briefing.trigger` subscriptions that are due (Requirements 2.1, 2.3).
 *
 * Each subscription is evaluated independently via {@link isSubscriptionDue}, so
 * one customer's non-match (or malformed schedule) never affects another's. The
 * handler (task 7.3) delivers a `briefing.trigger` webhook for each returned
 * subscription. Input order is preserved for deterministic delivery.
 */
export function dueSubscriptions(
  subscriptions: readonly WebhookSubscription[],
  now: Date,
): WebhookSubscription[] {
  return subscriptions.filter((subscription) =>
    isSubscriptionDue(subscription, now),
  );
}
