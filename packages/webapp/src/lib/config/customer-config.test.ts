import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  BRIEFING_PROMPT_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  MAX_MAGNITUDE,
  MIN_MAGNITUDE,
  REGIONS,
  configToForm,
  emptyConfigForm,
  validateConfigForm,
  type ConfigFormValues,
  type CustomerConfig,
} from "./customer-config.js";

/** A fully-valid form, used as a baseline that individual tests mutate. */
function validForm(
  overrides: Partial<ConfigFormValues> = {},
): ConfigFormValues {
  return {
    displayName: "West Coast Ops",
    minMagnitude: "4.5",
    region: "pacific",
    maxDepthKm: "70",
    briefingPrompt: "Summarize notable seismic activity for the ops team.",
    briefingSchedule: "0 9 * * *",
    ...overrides,
  };
}

describe("validateConfigForm — happy path", () => {
  it("accepts a fully-populated valid form and builds the request body", () => {
    const result = validateConfigForm(validForm());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        displayName: "West Coast Ops",
        subscriptionParams: {
          minMagnitude: 4.5,
          region: "pacific",
          maxDepthKm: 70,
        },
        briefingPrompt: "Summarize notable seismic activity for the ops team.",
        briefingSchedule: "0 9 * * *",
      });
    }
  });

  it("treats blank filter fields as 'no filter' (omits them)", () => {
    const result = validateConfigForm(
      validForm({ minMagnitude: "", region: "", maxDepthKm: "" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.subscriptionParams).toEqual({});
    }
  });

  it("trims whitespace from displayName and briefingPrompt", () => {
    const result = validateConfigForm(
      validForm({ displayName: "  Ops  ", briefingPrompt: "  hello  " }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.displayName).toBe("Ops");
      expect(result.value.briefingPrompt).toBe("hello");
    }
  });
});

describe("validateConfigForm — field errors", () => {
  it("rejects an empty display name", () => {
    const result = validateConfigForm(validForm({ displayName: "   " }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.displayName).toBeDefined();
    }
  });

  it("rejects a display name over the max length", () => {
    const result = validateConfigForm(
      validForm({ displayName: "x".repeat(DISPLAY_NAME_MAX_LENGTH + 1) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.displayName).toBeDefined();
    }
  });

  it.each(["-0.1", "10.1", "abc"])(
    "rejects out-of-range / non-numeric magnitude %s",
    (value) => {
      const result = validateConfigForm(validForm({ minMagnitude: value }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.minMagnitude).toBeDefined();
      }
    },
  );

  it("rejects a non-positive maxDepthKm", () => {
    const result = validateConfigForm(validForm({ maxDepthKm: "0" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.maxDepthKm).toBeDefined();
    }
  });

  it("rejects an empty briefing prompt", () => {
    const result = validateConfigForm(validForm({ briefingPrompt: "   " }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.briefingPrompt).toBeDefined();
    }
  });

  it("rejects a briefing prompt over the max length", () => {
    const result = validateConfigForm(
      validForm({ briefingPrompt: "y".repeat(BRIEFING_PROMPT_MAX_LENGTH + 1) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.briefingPrompt).toBeDefined();
    }
  });

  it.each(["", "not a cron", "0 9 * *", "0 9 * * * *"])(
    "rejects invalid cron expression %j",
    (value) => {
      const result = validateConfigForm(validForm({ briefingSchedule: value }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.briefingSchedule).toBeDefined();
      }
    },
  );
});

describe("configToForm / emptyConfigForm", () => {
  it("round-trips a stored config back into form values", () => {
    const config: CustomerConfig = {
      customerId: "11111111-1111-4111-8111-111111111111",
      displayName: "Ops",
      subscriptionParams: { minMagnitude: 5, region: "asia", maxDepthKm: 30 },
      briefingPrompt: "prompt",
      briefingSchedule: "*/15 * * * *",
      active: true,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
    };
    const form = configToForm(config);
    expect(form).toEqual({
      displayName: "Ops",
      minMagnitude: "5",
      region: "asia",
      maxDepthKm: "30",
      briefingPrompt: "prompt",
      briefingSchedule: "*/15 * * * *",
    });
  });

  it("maps omitted filter params to empty strings", () => {
    const config: CustomerConfig = {
      customerId: "11111111-1111-4111-8111-111111111111",
      displayName: "Ops",
      subscriptionParams: {},
      briefingPrompt: "prompt",
      briefingSchedule: "0 9 * * *",
      active: true,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    const form = configToForm(config);
    expect(form.minMagnitude).toBe("");
    expect(form.region).toBe("");
    expect(form.maxDepthKm).toBe("");
  });

  it("emptyConfigForm produces a form that fails validation (prompt required)", () => {
    const result = validateConfigForm(emptyConfigForm());
    expect(result.ok).toBe(false);
  });
});

describe("validateConfigForm — properties", () => {
  // Property: any magnitude inside [MIN, MAX] is accepted and echoed back; any
  // value outside the bounds is rejected with a minMagnitude error. Mirrors the
  // shared zod schema (Requirement 16.2).
  it("accepts in-range magnitudes and rejects out-of-range ones", () => {
    fc.assert(
      fc.property(
        fc.double({
          min: -100,
          max: 110,
          noNaN: true,
          noDefaultInfinity: true,
        }),
        (magnitude) => {
          const result = validateConfigForm(
            validForm({ minMagnitude: String(magnitude) }),
          );
          const inRange =
            magnitude >= MIN_MAGNITUDE && magnitude <= MAX_MAGNITUDE;
          if (inRange) {
            expect(result.ok).toBe(true);
            if (result.ok) {
              expect(result.value.subscriptionParams.minMagnitude).toBe(
                magnitude,
              );
            }
          } else {
            expect(result.ok).toBe(false);
            if (!result.ok) {
              expect(result.errors.minMagnitude).toBeDefined();
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // Property: every region in the shared enum is accepted; the empty selection
  // ("all regions") is accepted and omits the region (Requirement 16.3).
  it("accepts every valid region and the empty selection", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<"" | (typeof REGIONS)[number]>("", ...REGIONS),
        (region) => {
          const result = validateConfigForm(validForm({ region }));
          expect(result.ok).toBe(true);
          if (result.ok) {
            if (region === "") {
              expect(result.value.subscriptionParams.region).toBeUndefined();
            } else {
              expect(result.value.subscriptionParams.region).toBe(region);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Property: a non-empty prompt within the length bound is always accepted;
  // an over-length prompt is always rejected (Requirement 16.4).
  it("enforces the briefing prompt length bound", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4000 }), (len) => {
        const result = validateConfigForm(
          validForm({ briefingPrompt: "a".repeat(len) }),
        );
        if (len <= BRIEFING_PROMPT_MAX_LENGTH) {
          expect(result.ok).toBe(true);
        } else {
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.errors.briefingPrompt).toBeDefined();
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
