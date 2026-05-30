/**
 * Dual-authorization logic for the Data API Lambda (Requirements 9.1, 9.2,
 * 9.3, 5.3).
 *
 * The Data API is fronted by two API Gateway authorizers on the same route
 * surface:
 *
 * - **Cognito User Pool Authorizer** (webapp): API Gateway validates the JWT
 *   and passes its claims to the Lambda via
 *   `event.requestContext.authorizer.claims`. The `sub` claim equals the
 *   caller's `customerId`. Cognito callers may only access their own customer
 *   resources — the `customerId` in the URL path MUST equal the JWT `sub`,
 *   otherwise the request is rejected with HTTP 403.
 *
 * - **IAM Authorizer** (Serverless Agent, Subscription Manager, Webhook
 *   Receiver): SigV4-signed requests. API Gateway populates
 *   `event.requestContext.identity` with the caller ARN and leaves
 *   `authorizer` unset. IAM callers may access any customer's data (they
 *   process events for all customers); access is restricted at the IAM layer
 *   to the specific backend roles granted `execute-api:Invoke`.
 *
 * This module turns the raw request context into a normalized {@link
 * AuthContext} and enforces the per-customer access rule.
 */

import type { APIGatewayProxyEvent } from "aws-lambda";

import { forbidden } from "./http.js";
import type { AuthContext } from "./types.js";

/**
 * Derive the {@link AuthContext} from the API Gateway request context.
 *
 * Cognito requests are recognized by the presence of a `sub` claim under
 * `requestContext.authorizer.claims`. Everything else is treated as an IAM
 * (SigV4) caller, identified by the caller ARN under `requestContext.identity`.
 *
 * @throws HttpError 403 when neither a Cognito `sub` claim nor an IAM caller
 *   identity can be determined (the request is unauthenticated as far as the
 *   handler can tell — API Gateway should normally have rejected it already).
 */
export function getAuthContext(event: APIGatewayProxyEvent): AuthContext {
  const requestContext = event.requestContext;
  const authorizer = requestContext?.authorizer as
    | { claims?: Record<string, unknown> }
    | null
    | undefined;

  const claims = authorizer?.claims;
  const sub = claims?.sub;
  if (typeof sub === "string" && sub.length > 0) {
    return { authType: "cognito", cognitoSub: sub };
  }

  // IAM (SigV4) caller. API Gateway records the caller ARN on the identity.
  const identity = requestContext?.identity as
    | { userArn?: string | null; caller?: string | null }
    | undefined;
  const iamArn = identity?.userArn ?? identity?.caller ?? undefined;
  if (iamArn) {
    return { authType: "iam", iamArn };
  }

  // No recognizable authorization context. Treat as forbidden rather than
  // assuming a caller identity.
  throw forbidden("Unable to determine caller authorization context");
}

/**
 * Enforce per-customer access for the resolved route.
 *
 * - Cognito callers: the `customerId` path parameter MUST equal the JWT `sub`
 *   (Requirements 5.3, 9.2). A mismatch — or a Cognito caller reaching a route
 *   that has no `customerId` (a backend-only route) — is rejected with 403.
 * - IAM callers: allowed to access any customer (Requirement 9.3).
 *
 * @param auth - The normalized auth context.
 * @param customerScoped - Whether the matched route is scoped to a customer.
 * @param customerId - The `customerId` path parameter, when present.
 * @throws HttpError 403 on a Cognito ownership mismatch.
 */
export function enforceCustomerAccess(
  auth: AuthContext,
  customerScoped: boolean,
  customerId: string | undefined,
): void {
  if (auth.authType === "iam") {
    // Backend callers may act on behalf of any customer (Requirement 9.3).
    return;
  }

  // Cognito caller (Requirements 5.3, 9.2).
  if (!customerScoped || customerId === undefined) {
    // A Cognito-authenticated user has no business calling backend-only routes
    // (e.g. subscription lookups keyed only by subscriptionId).
    throw forbidden("This resource is not accessible to user credentials");
  }

  if (customerId !== auth.cognitoSub) {
    throw forbidden("customerId does not match authenticated user");
  }
}
