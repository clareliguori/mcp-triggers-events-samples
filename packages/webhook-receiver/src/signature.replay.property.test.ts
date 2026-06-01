/**
 * Property 2: Replay Attack Rejection (task 5.3).
 *
 * _For any_ webhook delivery whose `webhook-timestamp` is more than the
 * replay-protection window (5 minutes / {@link WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS})
 * older OR newer than the current time, {@link verifyWebhook} SHALL reject the
 * delivery **regardless of whether the signature is valid**.
 *
 * Because the receiver checks the timestamp window before it ever touches the
 * signature, an out-of-tolerance delivery is always rejected with
 * `timestamp_out_of_tolerance` whether the payload was signed with the
 * verifying secret (case a) or carries a deliberately bad signature (case b).
 * The two cases producing the identical rejection is exactly what "regardless
 * of signature validity" means. A control property confirms that in-tolerance,
 * correctly-signed deliveries still pass so the test cannot trivially reject
 * everything.
 *
 * The property is exercised end-to-end through the real `signWebhook` /
 * `verifyWebhook` pair (the most faithful check of the requirement). Since
 * `verifyWebhook` reads the wall clock internally and offers no `now` override,
 * each offset is applied relative to a fresh `Date.now()` inside the property
 * body, and offsets carry a small (2s) margin past the boundary so the handful
 * of milliseconds between signing and verifying can never cross the 300s window
 * (which would make the test flaky). The exact inclusive boundary is covered
 * deterministically by the unit tests for `isTimestampWithinTolerance`.
 *
 * **Validates: Requirement 3.3**
 */

import { WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS } from "@mcp-events/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { signWebhook, verifyWebhook } from "./signature.js";

/** Per-property run count. Spec floor is 100 random inputs per property. */
const NUM_RUNS = 100;

/**
 * Safety margin (seconds) added past the tolerance boundary so the small,
 * unavoidable delay between computing the timestamp and `verifyWebhook` reading
 * the clock can never pull an out-of-tolerance offset back inside the window
 * (or push an in-tolerance offset out of it).
 */
const MARGIN_SECONDS = 2;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * A structurally valid per-subscription `whsec_` secret: the `whsec_` prefix
 * plus base64 of 24-64 random bytes (matching how secrets are generated for
 * subscriptions).
 */
const secretArb: fc.Arbitrary<string> = fc
  .uint8Array({ minLength: 24, maxLength: 64 })
  .map((bytes) => `whsec_${Buffer.from(bytes).toString("base64")}`);

/**
 * An arbitrary serialized webhook body (the exact bytes that get signed).
 *
 * Constrained to valid JSON because the `standardwebhooks` package that backs
 * {@link verifyWebhook} `JSON.parse`s the payload as part of `verify()` — real
 * MCP webhook deliveries are always JSON event bodies, so a non-JSON string
 * would be outside the production input space and would surface as a parse
 * failure rather than exercising the timestamp/signature logic under test.
 */
const payloadArb: fc.Arbitrary<string> = fc.json();

/**
 * An offset (in seconds) that is firmly OUTSIDE the replay-protection window in
 * either direction: more than the tolerance into the past (negative) or future
 * (positive). The magnitude starts a couple seconds past the boundary to avoid
 * timing flakiness and ranges up to a year.
 */
const outOfToleranceOffsetArb: fc.Arbitrary<number> = fc
  .tuple(
    fc.integer({
      min: WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS + MARGIN_SECONDS,
      max: 365 * 24 * 60 * 60,
    }),
    fc.boolean(),
  )
  .map(([magnitude, future]) => (future ? magnitude : -magnitude));

/**
 * An offset (in seconds) that is firmly INSIDE the replay-protection window
 * (used by the control property). Kept a margin away from the boundary for the
 * same anti-flakiness reason.
 */
const inToleranceOffsetArb: fc.Arbitrary<number> = fc.integer({
  min: -(WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS - MARGIN_SECONDS),
  max: WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS - MARGIN_SECONDS,
});

// ---------------------------------------------------------------------------
// Property 2 — Replay Attack Rejection
// ---------------------------------------------------------------------------

describe("Property 2: Replay Attack Rejection", () => {
  it("3.3: rejects an out-of-tolerance delivery even when correctly signed", () => {
    fc.assert(
      fc.property(
        payloadArb,
        secretArb,
        outOfToleranceOffsetArb,
        (payload, secret, offsetSeconds) => {
          // Sign correctly, but stamp the delivery outside the replay window.
          const timestamp = new Date(Date.now() + offsetSeconds * 1000);
          const headers = signWebhook(payload, secret, { timestamp });

          // Even with a valid signature, the stale/future timestamp wins.
          const result = verifyWebhook(payload, headers, secret);
          expect(result).toEqual({
            valid: false,
            reason: "timestamp_out_of_tolerance",
          });
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("3.3: rejects an out-of-tolerance delivery carrying a bad signature", () => {
    fc.assert(
      fc.property(
        payloadArb,
        secretArb,
        outOfToleranceOffsetArb,
        (payload, secret, offsetSeconds) => {
          const timestamp = new Date(Date.now() + offsetSeconds * 1000);
          const headers = signWebhook(payload, secret, { timestamp });

          // Corrupt the signature so it can never verify, then confirm the
          // delivery is still rejected on the timestamp window alone — i.e.
          // rejection is independent of signature validity.
          const tampered = {
            ...headers,
            "webhook-signature": "v1,not-a-valid-signature",
          };
          const result = verifyWebhook(payload, tampered, secret);
          expect(result).toEqual({
            valid: false,
            reason: "timestamp_out_of_tolerance",
          });
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("3.3 (control): accepts an in-tolerance, correctly-signed delivery", () => {
    fc.assert(
      fc.property(
        payloadArb,
        secretArb,
        inToleranceOffsetArb,
        (payload, secret, offsetSeconds) => {
          const timestamp = new Date(Date.now() + offsetSeconds * 1000);
          const headers = signWebhook(payload, secret, { timestamp });

          const result = verifyWebhook(payload, headers, secret);
          expect(result).toEqual({ valid: true });
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
