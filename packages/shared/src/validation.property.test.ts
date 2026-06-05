/**
 * Property 12: Input Validation Correctness.
 *
 * Generates arbitrary CustomerConfig inputs with fast-check and verifies that
 * valid inputs are accepted and invalid inputs are rejected. The schema-level
 * rejection corresponds to the Data API returning HTTP 400 — wiring of the
 * status code lives in the data-api package; here we only assert that the
 * shared zod schemas correctly accept/reject inputs as required.
 *
 * **Validates: Requirements 16.1, 16.2, 16.3, 16.4, 16.5, 16.6**
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  BRIEFING_PROMPT_MAX_LENGTH,
  BRIEFING_PROMPT_MIN_LENGTH,
  BRIEFING_SCHEDULE_INTERVALS,
  MAX_MAGNITUDE,
  MIN_MAGNITUDE,
  REGIONS,
  UUID_V4_REGEX,
  customerConfigInputSchema,
  customerConfigSchema,
  subscriptionParamsSchema,
  uuidV4Schema,
  type Region,
} from "./index.js";

/** Per-property run count. fast-check defaults to 100; we set it explicitly. */
const NUM_RUNS = 100;

// ---------------------------------------------------------------------------
// Generators — valid inputs
// ---------------------------------------------------------------------------

const validUuidV4Arb = fc.uuid({ version: 4 });

const validRegionArb = fc.constantFrom<Region>(...REGIONS);

const validMinMagnitudeArb = fc.double({
  min: MIN_MAGNITUDE,
  max: MAX_MAGNITUDE,
  noNaN: true,
  noDefaultInfinity: true,
});

const validMaxDepthKmArb = fc.double({
  min: Number.EPSILON,
  max: 1000,
  noNaN: true,
  noDefaultInfinity: true,
});

const validBriefingPromptArb = fc.string({
  minLength: BRIEFING_PROMPT_MIN_LENGTH,
  maxLength: BRIEFING_PROMPT_MAX_LENGTH,
});

const validDisplayNameArb = fc.string({ minLength: 1, maxLength: 200 });


const validSubscriptionParamsArb = fc.record(
  {
    minMagnitude: validMinMagnitudeArb,
    region: validRegionArb,
    maxDepthKm: validMaxDepthKmArb,
  },
  { requiredKeys: [] }, // every field is optional
);

const validCustomerConfigInputArb = fc.record({
  displayName: validDisplayNameArb,
  subscriptionParams: validSubscriptionParamsArb,
  briefingPrompt: validBriefingPromptArb,
  briefingSchedule: fc.constantFrom(...BRIEFING_SCHEDULE_INTERVALS),
});

const validCustomerConfigArb = fc.record({
  customerId: validUuidV4Arb,
  displayName: validDisplayNameArb,
  subscriptionParams: validSubscriptionParamsArb,
  briefingPrompt: validBriefingPromptArb,
  briefingSchedule: fc.constantFrom(...BRIEFING_SCHEDULE_INTERVALS),
  active: fc.boolean(),
  createdAt: fc.date().map((d) => d.toISOString()),
  updatedAt: fc.date().map((d) => d.toISOString()),
});

// ---------------------------------------------------------------------------
// Generators — invalid inputs
// ---------------------------------------------------------------------------

/** Anything that is not a valid UUID v4 string. */
const invalidUuidV4Arb = fc.string().filter((s) => !UUID_V4_REGEX.test(s));

/** Finite numbers outside [0, 10]. */
const invalidMagnitudeArb = fc
  .double({ noNaN: true, noDefaultInfinity: true })
  .filter((n) => n < MIN_MAGNITUDE || n > MAX_MAGNITUDE);

/** Strings that are not one of the allowed region values. */
const invalidRegionArb = fc
  .string()
  .filter((s) => !(REGIONS as readonly string[]).includes(s));

/** Briefing prompts that are empty or exceed the max length. */
const invalidBriefingPromptArb = fc.oneof(
  fc.constant(""),
  fc.string({
    minLength: BRIEFING_PROMPT_MAX_LENGTH + 1,
    maxLength: BRIEFING_PROMPT_MAX_LENGTH + 100,
  }),
);


// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe("Property 12: Input Validation Correctness", () => {
  // -------------------------------------------------------------------------
  // 16.1 — customerId must conform to UUID v4
  // -------------------------------------------------------------------------

  it("16.1: uuidV4Schema accepts every UUID v4 produced by fast-check", () => {
    fc.assert(
      fc.property(validUuidV4Arb, (uuid) => {
        expect(uuidV4Schema.safeParse(uuid).success).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("16.1: uuidV4Schema rejects strings that are not UUID v4", () => {
    fc.assert(
      fc.property(invalidUuidV4Arb, (notUuid) => {
        expect(uuidV4Schema.safeParse(notUuid).success).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("16.1: customerConfigSchema rejects any non-UUID-v4 customerId", () => {
    fc.assert(
      fc.property(
        validCustomerConfigArb,
        invalidUuidV4Arb,
        (config, badCustomerId) => {
          const result = customerConfigSchema.safeParse({
            ...config,
            customerId: badCustomerId,
          });
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // 16.2 — minMagnitude must be in [0, 10]
  // -------------------------------------------------------------------------

  it("16.2: subscriptionParamsSchema accepts every minMagnitude in [0, 10]", () => {
    fc.assert(
      fc.property(validMinMagnitudeArb, (mag) => {
        expect(
          subscriptionParamsSchema.safeParse({ minMagnitude: mag }).success,
        ).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("16.2: customerConfigInputSchema rejects out-of-range minMagnitude", () => {
    fc.assert(
      fc.property(
        validCustomerConfigInputArb,
        invalidMagnitudeArb,
        (config, badMagnitude) => {
          const result = customerConfigInputSchema.safeParse({
            ...config,
            subscriptionParams: {
              ...config.subscriptionParams,
              minMagnitude: badMagnitude,
            },
          });
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // 16.3 — region must be a known enum value or undefined
  // -------------------------------------------------------------------------

  it("16.3: subscriptionParamsSchema accepts every allowed region (and undefined)", () => {
    fc.assert(
      fc.property(fc.option(validRegionArb, { nil: undefined }), (region) => {
        expect(subscriptionParamsSchema.safeParse({ region }).success).toBe(
          true,
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("16.3: customerConfigInputSchema rejects unknown region values", () => {
    fc.assert(
      fc.property(
        validCustomerConfigInputArb,
        invalidRegionArb,
        (config, badRegion) => {
          const result = customerConfigInputSchema.safeParse({
            ...config,
            subscriptionParams: {
              ...config.subscriptionParams,
              region: badRegion,
            },
          });
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // 16.4 — briefingPrompt non-empty and at most 2000 chars
  // -------------------------------------------------------------------------

  it("16.4: customerConfigInputSchema accepts briefingPrompt within length bounds", () => {
    fc.assert(
      fc.property(
        validCustomerConfigInputArb,
        validBriefingPromptArb,
        (config, prompt) => {
          const result = customerConfigInputSchema.safeParse({
            ...config,
            briefingPrompt: prompt,
          });
          expect(result.success).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("16.4: customerConfigInputSchema rejects empty or oversized briefingPrompt", () => {
    fc.assert(
      fc.property(
        validCustomerConfigInputArb,
        invalidBriefingPromptArb,
        (config, badPrompt) => {
          const result = customerConfigInputSchema.safeParse({
            ...config,
            briefingPrompt: badPrompt,
          });
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // 16.5 — briefingSchedule must be a valid interval in hours
  // -------------------------------------------------------------------------

  it("16.5: customerConfigInputSchema rejects invalid briefingSchedule", () => {
    fc.assert(
      fc.property(
        validCustomerConfigInputArb,
        fc.oneof(fc.double(), fc.constant(-1), fc.constant(0), fc.constant(200)),
        (config, badInterval) => {
          const result = customerConfigInputSchema.safeParse({
            ...config,
            briefingSchedule: badInterval,
          });
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // 16.6 — validation failures map to HTTP 400 semantics
  //
  // The actual HTTP 400 wiring lives in the data-api package; at the schema
  // layer that maps to `safeParse(...).success === false`. We assert that any
  // input that violates one or more of the constraints in 16.1-16.5 produces
  // a parse failure (which the Data API will translate into HTTP 400), and
  // that fully valid inputs always succeed.
  // -------------------------------------------------------------------------

  it("16.6: fully valid CustomerConfig inputs are always accepted", () => {
    fc.assert(
      fc.property(validCustomerConfigInputArb, (config) => {
        expect(customerConfigInputSchema.safeParse(config).success).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("16.6: any input violating one of 16.1-16.5 fails schema parsing", () => {
    // Pick one constraint at random for each generated case and inject an
    // invalid value for that field while leaving the others valid.
    const violator = fc.oneof(
      fc.record({
        kind: fc.constant("magnitude" as const),
        value: invalidMagnitudeArb,
      }),
      fc.record({
        kind: fc.constant("region" as const),
        value: invalidRegionArb,
      }),
      fc.record({
        kind: fc.constant("prompt" as const),
        value: invalidBriefingPromptArb,
      }),
      fc.record({
        kind: fc.constant("interval" as const),
        value: fc.oneof(fc.double(), fc.constant(-1), fc.constant(0), fc.constant(200)),
      }),
    );

    fc.assert(
      fc.property(validCustomerConfigInputArb, violator, (base, v) => {
        let mutated;
        switch (v.kind) {
          case "magnitude":
            mutated = {
              ...base,
              subscriptionParams: {
                ...base.subscriptionParams,
                minMagnitude: v.value,
              },
            };
            break;
          case "region":
            mutated = {
              ...base,
              subscriptionParams: {
                ...base.subscriptionParams,
                region: v.value,
              },
            };
            break;
          case "prompt":
            mutated = { ...base, briefingPrompt: v.value };
            break;
          case "interval":
            mutated = { ...base, briefingSchedule: v.value };
            break;
        }
        expect(customerConfigInputSchema.safeParse(mutated).success).toBe(
          false,
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
