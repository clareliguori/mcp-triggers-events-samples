import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { formatMagnitude, formatPeriod, formatTimestamp } from "./reports.js";

describe("formatTimestamp", () => {
  it("formats a valid ISO 8601 timestamp into a non-empty human string", () => {
    const out = formatTimestamp("2024-01-02T03:04:05.000Z");
    expect(out).not.toBe("");
    // It should not echo the raw ISO string back for a parseable input.
    expect(out).not.toBe("2024-01-02T03:04:05.000Z");
  });

  it("returns the original string unchanged when it cannot be parsed", () => {
    expect(formatTimestamp("not a date")).toBe("not a date");
    expect(formatTimestamp("")).toBe("");
  });
});

describe("formatPeriod", () => {
  it("joins the two endpoints with an en dash", () => {
    const out = formatPeriod(
      "2024-01-01T00:00:00.000Z",
      "2024-01-02T00:00:00.000Z",
    );
    expect(out).toContain("\u2013");
    expect(out.split("\u2013")).toHaveLength(2);
  });

  it("degrades gracefully for unparseable endpoints", () => {
    expect(formatPeriod("bad-start", "bad-end")).toBe(
      "bad-start \u2013 bad-end",
    );
  });
});

describe("formatMagnitude", () => {
  it("formats finite magnitudes to one decimal place", () => {
    expect(formatMagnitude(4.5)).toBe("4.5");
    expect(formatMagnitude(5)).toBe("5.0");
    expect(formatMagnitude(6.04)).toBe("6.0");
  });

  it("returns an em dash for non-finite magnitudes", () => {
    expect(formatMagnitude(Number.NaN)).toBe("\u2014");
    expect(formatMagnitude(Number.POSITIVE_INFINITY)).toBe("\u2014");
  });

  // Property: any finite magnitude formats to a string that parses back to the
  // value rounded to one decimal place (Requirement 10.4 — readable report
  // rendering).
  it("round-trips finite magnitudes to one decimal place", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 10, noNaN: true, noDefaultInfinity: true }),
        (magnitude) => {
          const formatted = formatMagnitude(magnitude);
          expect(formatted).toMatch(/^\d+\.\d$/);
          expect(Number(formatted)).toBeCloseTo(
            Math.round(magnitude * 10) / 10,
            5,
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});
