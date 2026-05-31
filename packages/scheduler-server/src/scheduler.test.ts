/**
 * Unit tests for cron schedule parsing and evaluation (task 7.1).
 *
 * These exercise the pure scheduler logic: field expansion across every syntax
 * form (`*`, single, range, step-from-wildcard, step-from-start, lists), range
 * validation, the 5-field expression parser, UTC minute-granular matching
 * (including the Vixie day-of-month / day-of-week OR rule), and the
 * per-subscription "is this customer due now" iteration that drives delivery
 * (Requirements 2.1, 2.3). The fast-check property test for this logic lives in
 * task 7.2.
 */

import type { WebhookSubscription } from "@mcp-events/shared";
import { describe, expect, it } from "vitest";

import {
  type ParsedCron,
  cronMatchesAt,
  dueSubscriptions,
  expandField,
  isSubscriptionDue,
  matchesCron,
  parseCron,
} from "./scheduler.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build an active briefing subscription with the given cron schedule. */
function makeSubscription(
  subscriptionId: string,
  schedule: string | undefined,
  status: WebhookSubscription["status"] = "active",
  eventName: WebhookSubscription["eventName"] = "briefing.trigger",
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

/** Convenience UTC Date constructor (month is 1-based here for readability). */
function utc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
}

const sorted = (values: ReadonlySet<number>): number[] =>
  [...values].sort((a, b) => a - b);

// ---------------------------------------------------------------------------
// expandField
// ---------------------------------------------------------------------------

describe("expandField", () => {
  it("expands a wildcard to the full inclusive range", () => {
    expect(sorted(expandField("*", 0, 5))).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("expands a single value", () => {
    expect(sorted(expandField("3", 0, 59))).toEqual([3]);
  });

  it("expands an inclusive range", () => {
    expect(sorted(expandField("1-5", 0, 59))).toEqual([1, 2, 3, 4, 5]);
  });

  it("expands a step from the field minimum (*/n)", () => {
    expect(sorted(expandField("*/15", 0, 59))).toEqual([0, 15, 30, 45]);
  });

  it("expands a step from an explicit start (m/n)", () => {
    expect(sorted(expandField("5/15", 0, 59))).toEqual([5, 20, 35, 50]);
  });

  it("expands a comma-separated list of mixed forms", () => {
    expect(sorted(expandField("1,5,9-11", 0, 59))).toEqual([1, 5, 9, 10, 11]);
  });

  it("applies the normalizer to each value", () => {
    // Day-of-week 7 normalizes to 0 (Sunday).
    expect(sorted(expandField("7", 0, 7, (v) => (v === 7 ? 0 : v)))).toEqual([
      0,
    ]);
  });

  it("throws on a value above the field max", () => {
    expect(() => expandField("60", 0, 59)).toThrow(/out of range/);
  });

  it("throws on a value below the field min", () => {
    expect(() => expandField("0", 1, 31)).toThrow(/out of range/);
  });

  it("throws on an inverted range", () => {
    expect(() => expandField("5-1", 0, 59)).toThrow(/inverted/);
  });

  it("throws on a zero or negative step", () => {
    expect(() => expandField("*/0", 0, 59)).toThrow(/step must be positive/);
  });

  it("throws on a structurally invalid part", () => {
    expect(() => expandField("abc", 0, 59)).toThrow(/invalid cron field part/);
  });
});

// ---------------------------------------------------------------------------
// parseCron
// ---------------------------------------------------------------------------

describe("parseCron", () => {
  it("parses a 5-field expression into per-field value sets", () => {
    const parsed = parseCron("0 9 * * *");
    expect(sorted(parsed.minutes)).toEqual([0]);
    expect(sorted(parsed.hours)).toEqual([9]);
    expect(parsed.daysOfMonth.size).toBe(31);
    expect(parsed.months.size).toBe(12);
    expect(parsed.daysOfWeek.size).toBe(7); // 0-6 after normalizing 7 -> 0
  });

  it("records which day fields are restricted", () => {
    expect(parseCron("0 9 * * *").domRestricted).toBe(false);
    expect(parseCron("0 9 * * *").dowRestricted).toBe(false);
    expect(parseCron("0 9 15 * *").domRestricted).toBe(true);
    expect(parseCron("0 9 * * 1").dowRestricted).toBe(true);
  });

  it("tolerates surrounding and repeated whitespace", () => {
    const parsed = parseCron("  0   9 * * *  ");
    expect(sorted(parsed.minutes)).toEqual([0]);
    expect(sorted(parsed.hours)).toEqual([9]);
  });

  it("throws when there are not exactly 5 fields", () => {
    expect(() => parseCron("0 9 * *")).toThrow(/5 fields/);
    expect(() => parseCron("0 9 * * * *")).toThrow(/5 fields/);
  });

  it("throws when a field value is out of range", () => {
    expect(() => parseCron("99 9 * * *")).toThrow(/out of range/);
  });

  it("normalizes day-of-week 7 to Sunday (0)", () => {
    expect(sorted(parseCron("0 9 * * 7").daysOfWeek)).toEqual([0]);
  });
});

// ---------------------------------------------------------------------------
// matchesCron — UTC, minute granular
// ---------------------------------------------------------------------------

describe("matchesCron", () => {
  it("matches when minute, hour, and month all match (every-day schedule)", () => {
    const parsed = parseCron("30 14 * * *");
    expect(matchesCron(parsed, utc(2024, 6, 10, 14, 30))).toBe(true);
  });

  it("does not match when the minute differs", () => {
    const parsed = parseCron("30 14 * * *");
    expect(matchesCron(parsed, utc(2024, 6, 10, 14, 31))).toBe(false);
  });

  it("does not match when the hour differs", () => {
    const parsed = parseCron("30 14 * * *");
    expect(matchesCron(parsed, utc(2024, 6, 10, 13, 30))).toBe(false);
  });

  it("ignores seconds and milliseconds (minute granularity)", () => {
    const parsed = parseCron("30 14 * * *");
    const date = new Date(Date.UTC(2024, 5, 10, 14, 30, 45, 678));
    expect(matchesCron(parsed, date)).toBe(true);
  });

  it("matches a */15 minute step at each step boundary", () => {
    const parsed = parseCron("*/15 * * * *");
    expect(matchesCron(parsed, utc(2024, 1, 1, 0, 0))).toBe(true);
    expect(matchesCron(parsed, utc(2024, 1, 1, 0, 15))).toBe(true);
    expect(matchesCron(parsed, utc(2024, 1, 1, 0, 45))).toBe(true);
    expect(matchesCron(parsed, utc(2024, 1, 1, 0, 16))).toBe(false);
  });

  it("matches a specific month only", () => {
    const parsed = parseCron("0 0 1 1 *"); // midnight on Jan 1
    expect(matchesCron(parsed, utc(2024, 1, 1, 0, 0))).toBe(true);
    expect(matchesCron(parsed, utc(2024, 2, 1, 0, 0))).toBe(false);
  });

  it("evaluates in UTC, not local time", () => {
    // 2024-06-10 is a Monday in UTC.
    const parsed = parseCron("0 0 * * 1");
    expect(matchesCron(parsed, utc(2024, 6, 10, 0, 0))).toBe(true);
  });

  describe("day-of-month vs day-of-week semantics", () => {
    it("ANDs the day match when only day-of-week is restricted", () => {
      // Every Monday: 2024-06-10 is Monday, 2024-06-11 is Tuesday.
      const parsed = parseCron("0 9 * * 1");
      expect(matchesCron(parsed, utc(2024, 6, 10, 9, 0))).toBe(true);
      expect(matchesCron(parsed, utc(2024, 6, 11, 9, 0))).toBe(false);
    });

    it("ANDs the day match when only day-of-month is restricted", () => {
      const parsed = parseCron("0 9 15 * *");
      expect(matchesCron(parsed, utc(2024, 6, 15, 9, 0))).toBe(true);
      expect(matchesCron(parsed, utc(2024, 6, 16, 9, 0))).toBe(false);
    });

    it("ORs the day match when BOTH day fields are restricted", () => {
      // The 15th OR any Monday. 2024-06-10 is Monday (not the 15th); the 15th
      // (2024-06-15) is a Saturday. Both should match.
      const parsed = parseCron("0 9 15 * 1");
      expect(matchesCron(parsed, utc(2024, 6, 10, 9, 0))).toBe(true); // Monday
      expect(matchesCron(parsed, utc(2024, 6, 15, 9, 0))).toBe(true); // the 15th
      // A day that is neither the 15th nor a Monday does not match.
      expect(matchesCron(parsed, utc(2024, 6, 12, 9, 0))).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// cronMatchesAt
// ---------------------------------------------------------------------------

describe("cronMatchesAt", () => {
  it("parses and evaluates in one call", () => {
    expect(cronMatchesAt("0 12 * * *", utc(2024, 3, 3, 12, 0))).toBe(true);
    expect(cronMatchesAt("0 12 * * *", utc(2024, 3, 3, 12, 1))).toBe(false);
  });

  it("propagates parse errors", () => {
    expect(() => cronMatchesAt("0 12 * *", utc(2024, 3, 3, 12, 0))).toThrow(
      /5 fields/,
    );
  });
});

// ---------------------------------------------------------------------------
// isSubscriptionDue / dueSubscriptions — per-customer iteration & isolation
// ---------------------------------------------------------------------------

describe("isSubscriptionDue", () => {
  const now = utc(2024, 6, 10, 9, 0); // Monday 09:00 UTC

  it("is due when an active briefing subscription's schedule matches", () => {
    expect(isSubscriptionDue(makeSubscription("a", "0 9 * * *"), now)).toBe(
      true,
    );
  });

  it("is not due when the schedule does not match the current time", () => {
    expect(isSubscriptionDue(makeSubscription("a", "0 10 * * *"), now)).toBe(
      false,
    );
  });

  it("is not due for a non-active subscription even if the schedule matches", () => {
    expect(
      isSubscriptionDue(makeSubscription("a", "0 9 * * *", "expired"), now),
    ).toBe(false);
    expect(
      isSubscriptionDue(makeSubscription("a", "0 9 * * *", "failed"), now),
    ).toBe(false);
  });

  it("is not due for a subscription with no schedule", () => {
    expect(isSubscriptionDue(makeSubscription("a", undefined), now)).toBe(
      false,
    );
  });

  it("is not due for a non-briefing event subscription", () => {
    expect(
      isSubscriptionDue(
        makeSubscription("a", "0 9 * * *", "active", "earthquake.detected"),
        now,
      ),
    ).toBe(false);
  });

  it("skips (does not throw) a subscription whose schedule is numerically invalid", () => {
    // "99 9 * * *" is structurally cron-shaped but out of range.
    expect(isSubscriptionDue(makeSubscription("a", "99 9 * * *"), now)).toBe(
      false,
    );
  });
});

describe("dueSubscriptions", () => {
  const now = utc(2024, 6, 10, 9, 0); // Monday 09:00 UTC

  it("returns only the active, matching subscriptions, preserving order (2.1)", () => {
    const subs = [
      makeSubscription("match-1", "0 9 * * *"), // due
      makeSubscription("wrong-time", "0 10 * * *"), // not due
      makeSubscription("match-2", "*/15 * * * *"), // due (minute 0)
    ];
    expect(dueSubscriptions(subs, now).map((s) => s.subscriptionId)).toEqual([
      "match-1",
      "match-2",
    ]);
  });

  it("isolates customers: one non-match or bad schedule does not affect others (2.3)", () => {
    const subs = [
      makeSubscription("bad-schedule", "99 9 * * *"), // skipped, no throw
      makeSubscription("not-due", "0 10 * * *"), // not due
      makeSubscription("due", "0 9 * * *"), // due
    ];
    expect(dueSubscriptions(subs, now).map((s) => s.subscriptionId)).toEqual([
      "due",
    ]);
  });

  it("returns no subscriptions when none are due", () => {
    const subs = [
      makeSubscription("a", "0 10 * * *"),
      makeSubscription("b", "0 11 * * *"),
    ];
    expect(dueSubscriptions(subs, now)).toEqual([]);
  });

  it("returns nothing for an empty subscription list", () => {
    expect(dueSubscriptions([], now)).toEqual([]);
  });

  it("treats two customers with the same schedule independently", () => {
    const parsed: ParsedCron = parseCron("0 9 * * *");
    // Sanity: the shared schedule does match `now`.
    expect(matchesCron(parsed, now)).toBe(true);
    const subs = [
      makeSubscription("cust-1", "0 9 * * *"),
      makeSubscription("cust-2", "0 9 * * *"),
    ];
    expect(dueSubscriptions(subs, now).map((s) => s.subscriptionId)).toEqual([
      "cust-1",
      "cust-2",
    ]);
  });
});
