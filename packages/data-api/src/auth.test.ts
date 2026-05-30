/**
 * Unit tests for the Data API dual-authorization logic (task 4.1).
 *
 * Covers:
 * - deriving the auth context from a Cognito authorizer claims object,
 * - deriving the auth context from an IAM (SigV4) caller identity,
 * - rejecting requests with no recognizable caller identity (403),
 * - Cognito ownership enforcement: match allows, mismatch -> 403
 *   (Requirements 5.3, 9.2),
 * - Cognito callers rejected from non-customer-scoped routes (403),
 * - IAM callers allowed against any customer (Requirement 9.3).
 */

import type { APIGatewayProxyEvent } from "aws-lambda";
import { describe, expect, it } from "vitest";

import { enforceCustomerAccess, getAuthContext } from "./auth.js";
import { HttpError } from "./http.js";
import type { AuthContext } from "./types.js";

const SUB = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

/** Build a minimal event with a Cognito authorizer claims object. */
function cognitoEvent(sub: string | undefined): APIGatewayProxyEvent {
  return {
    requestContext: {
      authorizer: sub === undefined ? { claims: {} } : { claims: { sub } },
    },
  } as unknown as APIGatewayProxyEvent;
}

/** Build a minimal event with an IAM caller identity. */
function iamEvent(userArn: string): APIGatewayProxyEvent {
  return {
    requestContext: {
      authorizer: null,
      identity: { userArn },
    },
  } as unknown as APIGatewayProxyEvent;
}

describe("getAuthContext", () => {
  it("derives a cognito context from a sub claim", () => {
    const auth = getAuthContext(cognitoEvent(SUB));
    expect(auth.authType).toBe("cognito");
    expect(auth.cognitoSub).toBe(SUB);
    expect(auth.iamArn).toBeUndefined();
  });

  it("derives an iam context from the caller ARN", () => {
    const arn = "arn:aws:sts::123456789012:assumed-role/AgentRole/session";
    const auth = getAuthContext(iamEvent(arn));
    expect(auth.authType).toBe("iam");
    expect(auth.iamArn).toBe(arn);
    expect(auth.cognitoSub).toBeUndefined();
  });

  it("prefers cognito when a sub claim is present even with identity set", () => {
    const event = {
      requestContext: {
        authorizer: { claims: { sub: SUB } },
        identity: { userArn: "arn:aws:iam::123:role/x" },
      },
    } as unknown as APIGatewayProxyEvent;
    expect(getAuthContext(event).authType).toBe("cognito");
  });

  it("throws 403 when no caller identity can be determined", () => {
    const event = {
      requestContext: { authorizer: null, identity: {} },
    } as unknown as APIGatewayProxyEvent;
    expect(() => getAuthContext(event)).toThrow(HttpError);
    try {
      getAuthContext(event);
    } catch (e) {
      expect((e as HttpError).statusCode).toBe(403);
    }
  });

  it("treats an empty-string sub as not authenticated via cognito", () => {
    // No identity either -> forbidden.
    expect(() => getAuthContext(cognitoEvent(""))).toThrow(HttpError);
  });
});

describe("enforceCustomerAccess", () => {
  const cognito: AuthContext = { authType: "cognito", cognitoSub: SUB };
  const iam: AuthContext = {
    authType: "iam",
    iamArn: "arn:aws:iam::123:role/Agent",
  };

  it("allows a cognito caller to access their own customerId", () => {
    expect(() => enforceCustomerAccess(cognito, true, SUB)).not.toThrow();
  });

  it("rejects a cognito caller accessing another customerId with 403", () => {
    try {
      enforceCustomerAccess(cognito, true, OTHER);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).statusCode).toBe(403);
    }
  });

  it("rejects a cognito caller on a non-customer-scoped route with 403", () => {
    try {
      enforceCustomerAccess(cognito, false, undefined);
      throw new Error("expected throw");
    } catch (e) {
      expect((e as HttpError).statusCode).toBe(403);
    }
  });

  it("rejects a cognito caller on a customer-scoped route missing the param", () => {
    try {
      enforceCustomerAccess(cognito, true, undefined);
      throw new Error("expected throw");
    } catch (e) {
      expect((e as HttpError).statusCode).toBe(403);
    }
  });

  it("allows an iam caller to access any customer", () => {
    expect(() => enforceCustomerAccess(iam, true, SUB)).not.toThrow();
    expect(() => enforceCustomerAccess(iam, true, OTHER)).not.toThrow();
  });

  it("allows an iam caller on non-customer-scoped routes", () => {
    expect(() => enforceCustomerAccess(iam, false, undefined)).not.toThrow();
  });
});
