/**
 * Property 11: Cognito Authorization Enforcement.
 *
 * Generates arbitrary `customerId` (URL path param) and JWT `sub` pairs with
 * fast-check and verifies the Data API's per-customer access rule:
 *
 * - When the JWT `sub` MATCHES the `customerId` in the URL path, a Cognito
 *   caller is allowed — the request dispatches to the route handler and does
 *   NOT return 403 (the matched + authorized config stub currently returns
 *   501; "allowed" therefore means "any status other than 403").
 * - When they MISMATCH, the Data API always returns HTTP 403.
 *
 * The property is exercised two ways:
 *   1. End-to-end through the real `handler` with synthetic API Gateway proxy
 *      events (the most faithful check of the requirement), and
 *   2. directly against `enforceCustomerAccess`, which lets us feed truly
 *      arbitrary string pairs (including characters that would not survive URL
 *      path routing) for broader input coverage.
 *
 * **Validates: Requirements 5.3, 9.2**
 */

import type { APIGatewayProxyEvent } from "aws-lambda";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { enforceCustomerAccess } from "./auth.js";
import { handler } from "./handler.js";
import { HttpError } from "./http.js";
import type { AuthContext } from "./types.js";

/** Per-property run count. Spec floor is 100 random inputs per property. */
const NUM_RUNS = 100;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * A URL-path-safe, non-empty identifier. Restricting to this character set
 * keeps the value intact through API Gateway path routing (no `/`, no `%`
 * escaping surprises), so the customer-scoped route always matches and the
 * only variable under test is the sub-vs-customerId comparison.
 */
const ID_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_".split("");

const safeIdArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...ID_CHARS), { minLength: 1, maxLength: 40 })
  .map((chars) => chars.join(""));

/** A pair of distinct URL-path-safe identifiers (for the mismatch case). */
const distinctSafeIdPairArb: fc.Arbitrary<[string, string]> = fc
  .tuple(safeIdArb, safeIdArb)
  .filter(([a, b]) => a !== b);

/** An arbitrary non-empty string (used for the direct-enforcement checks). */
const nonEmptyStringArb = fc.string({ minLength: 1 });

/** A pair of distinct arbitrary strings (sub is non-empty). */
const distinctStringPairArb: fc.Arbitrary<[string, string]> = fc
  .tuple(nonEmptyStringArb, fc.string())
  .filter(([sub, customerId]) => sub !== customerId);

// ---------------------------------------------------------------------------
// Synthetic event helper
// ---------------------------------------------------------------------------

/**
 * Build a synthetic API Gateway proxy event for a Cognito caller hitting a
 * customer-scoped route (`GET /customers/:customerId/config`). The JWT `sub`
 * claim is carried under `requestContext.authorizer.claims`, mirroring how the
 * Cognito User Pool authorizer surfaces claims to the Lambda.
 */
function cognitoConfigEvent(
  customerId: string,
  sub: string,
): APIGatewayProxyEvent {
  return {
    httpMethod: "GET",
    path: `/customers/${customerId}/config`,
    body: null,
    isBase64Encoded: false,
    queryStringParameters: null,
    requestContext: {
      authorizer: { claims: { sub } },
    },
  } as unknown as APIGatewayProxyEvent;
}

// ---------------------------------------------------------------------------
// Property tests — end-to-end through the real handler
// ---------------------------------------------------------------------------

describe("Property 11: Cognito Authorization Enforcement (handler)", () => {
  it("5.3/9.2: allows access when JWT sub matches the URL customerId", async () => {
    await fc.assert(
      fc.asyncProperty(safeIdArb, async (id) => {
        const res = await handler(cognitoConfigEvent(id, id));
        // Match => request is dispatched (not a 403). The config route is a
        // task-4.3 stub that returns 501, so any non-403 status confirms the
        // caller was authorized and the request reached the route handler.
        expect(res.statusCode).not.toBe(403);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("5.3/9.2: returns 403 when JWT sub does not match the URL customerId", async () => {
    await fc.assert(
      fc.asyncProperty(distinctSafeIdPairArb, async ([customerId, sub]) => {
        const res = await handler(cognitoConfigEvent(customerId, sub));
        expect(res.statusCode).toBe(403);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property tests — directly against enforceCustomerAccess
// ---------------------------------------------------------------------------

describe("Property 11: Cognito Authorization Enforcement (enforceCustomerAccess)", () => {
  it("5.3/9.2: never throws when customerId equals the Cognito sub", () => {
    fc.assert(
      fc.property(nonEmptyStringArb, (id) => {
        const auth: AuthContext = { authType: "cognito", cognitoSub: id };
        expect(() => enforceCustomerAccess(auth, true, id)).not.toThrow();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("5.3/9.2: always throws HttpError 403 when customerId differs from the sub", () => {
    fc.assert(
      fc.property(distinctStringPairArb, ([sub, customerId]) => {
        const auth: AuthContext = { authType: "cognito", cognitoSub: sub };
        let thrown: unknown;
        try {
          enforceCustomerAccess(auth, true, customerId);
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(HttpError);
        expect((thrown as HttpError).statusCode).toBe(403);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
