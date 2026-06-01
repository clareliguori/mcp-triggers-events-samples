/**
 * Property 1: Webhook Signature Round-Trip.
 *
 * Exhaustively exercises the sign/verify contract of the Standard Webhooks
 * signature library (task 5.1) with fast-check:
 *
 * - For ANY payload and ANY per-subscription `whsec_` secret, signing the
 *   payload with the secret and then verifying the resulting headers against
 *   the SAME payload and secret SHALL return `{ valid: true }`.
 * - For ANY payload signed with secret A, verifying with a DIFFERENT secret B
 *   (A ≠ B) SHALL return `{ valid: false, reason: "invalid_signature" }`.
 *
 * Deliveries are signed with a fresh (current) timestamp so the 5-minute
 * replay-protection window (Property 2, task 5.3) always passes and the only
 * behavior under test here is the HMAC round trip / secret mismatch.
 *
 * **Validates: Requirements 3.1, 3.2, 14.5, 17.1**
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { signWebhook, verifyWebhook } from "./signature.js";

/** Per-property run count. Spec floor is 100 random inputs per property. */
const NUM_RUNS = 100;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Build a structurally valid Standard Webhooks `whsec_` secret from raw key
 * material: the literal `whsec_` prefix followed by base64 of 24-64 random
 * bytes (per the design's secret format). Generating from explicit bytes lets
 * the mismatch property guarantee the two secrets carry distinct key material.
 */
function toSecret(bytes: Uint8Array): string {
  return `whsec_${Buffer.from(bytes).toString("base64")}`;
}

/** Raw `whsec_` key material: 24-64 bytes, as the design specifies. */
const secretBytesArb: fc.Arbitrary<Uint8Array> = fc.uint8Array({
  minLength: 24,
  maxLength: 64,
});

/** An arbitrary valid per-subscription `whsec_` secret. */
const secretArb: fc.Arbitrary<string> = secretBytesArb.map(toSecret);

/**
 * An arbitrary serialized webhook payload. The `standardwebhooks` library
 * `verify()` parses the body as JSON, and in this system every delivery body is
 * a serialized JSON event envelope, so the input space is constrained to valid
 * JSON: arbitrary JSON values (objects, arrays, scalars) plus realistic event
 * envelopes for broad-but-faithful coverage.
 */
const payloadArb: fc.Arbitrary<string> = fc.oneof(
  fc.json(),
  fc
    .record({
      eventId: fc.uuid(),
      name: fc.constantFrom("earthquake.detected", "briefing.trigger"),
      timestamp: fc.date().map((d) => d.toISOString()),
      data: fc.object(),
    })
    .map((event) => JSON.stringify(event)),
);

/**
 * A pair of valid `whsec_` secrets built from DISTINCT key material. Filtering
 * on the underlying bytes (rather than the encoded strings) guarantees the two
 * secrets differ in the bytes that actually key the HMAC.
 */
const distinctSecretPairArb: fc.Arbitrary<[string, string]> = fc
  .tuple(secretBytesArb, secretBytesArb)
  .filter(([a, b]) => !bytesEqual(a, b))
  .map(([a, b]) => [toSecret(a), toSecret(b)]);

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe("Property 1: Webhook Signature Round-Trip", () => {
  it("3.1/3.2/17.1: sign then verify with the SAME secret returns valid:true", () => {
    fc.assert(
      fc.property(payloadArb, secretArb, (payload, secret) => {
        const headers = signWebhook(payload, secret);
        expect(verifyWebhook(payload, headers, secret)).toEqual({
          valid: true,
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("3.1/3.2/14.5/17.1: verifying with a DIFFERENT secret returns invalid_signature", () => {
    fc.assert(
      fc.property(
        payloadArb,
        distinctSecretPairArb,
        (payload, [secretA, secretB]) => {
          const headers = signWebhook(payload, secretA);
          expect(verifyWebhook(payload, headers, secretB)).toEqual({
            valid: false,
            reason: "invalid_signature",
          });
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
