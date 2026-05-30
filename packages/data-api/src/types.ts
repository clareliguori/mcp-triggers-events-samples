/**
 * Shared types for the Data API Lambda.
 *
 * These describe the request/dispatch surface used by the handler (routing +
 * authorization, task 4.1) and the per-route handlers implemented in tasks
 * 4.3-4.6. Keeping them in their own module avoids import cycles between
 * `handler.ts`, `router.ts`, `auth.ts`, and the `routes/*` modules.
 */

import type { APIGatewayProxyEvent } from "aws-lambda";

/** Which authorizer admitted the request (Requirement 9.1). */
export type AuthType = "cognito" | "iam";

/**
 * Normalized authorization context derived from
 * `event.requestContext.authorizer` (Cognito) or
 * `event.requestContext.identity` (IAM). See {@link AuthType}.
 */
export interface AuthContext {
  authType: AuthType;
  /** Cognito JWT `sub` claim (== customerId) for webapp callers. */
  cognitoSub?: string;
  /** Caller IAM role ARN for backend (SigV4) callers. */
  iamArn?: string;
}

/**
 * Result returned by a route handler. The {@link RouteContext.body} of the
 * response is JSON-serialized by the handler; `undefined` yields an empty body.
 */
export interface ApiResult {
  statusCode: number;
  body?: unknown;
}

/**
 * Everything a route handler needs to service a request. Built by the handler
 * after the route is matched and authorization has passed.
 */
export interface RouteContext {
  /** The raw API Gateway proxy event. */
  event: APIGatewayProxyEvent;
  /** Upper-case HTTP method (`GET`, `PUT`, ...). */
  method: string;
  /** Path parameters extracted from the matched route pattern. */
  pathParameters: Record<string, string>;
  /** Query string parameters (never null; empty object when absent). */
  query: Record<string, string | undefined>;
  /** Parsed JSON request body, or `undefined` when there is no body. */
  body: unknown;
  /** Normalized authorization context. */
  auth: AuthContext;
}

/** A single route handler. Implemented by the `routes/*` modules. */
export type RouteHandler = (ctx: RouteContext) => Promise<ApiResult>;

/** Static definition of one route in the route table. */
export interface RouteDefinition {
  /** Upper-case HTTP method. */
  method: string;
  /** Human-readable pattern, e.g. `/customers/:customerId/config`. */
  pattern: string;
  /**
   * Whether this route is scoped to a single customer (its pattern contains
   * `:customerId`). Cognito callers may only access customer-scoped routes,
   * and only for their own `customerId` (Requirements 5.3, 9.2).
   */
  customerScoped: boolean;
  /** The handler invoked when this route matches. */
  handler: RouteHandler;
}

/** A matched route plus the path parameters extracted from the request. */
export interface RouteMatch {
  route: RouteDefinition;
  params: Record<string, string>;
}
