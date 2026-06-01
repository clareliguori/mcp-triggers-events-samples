/**
 * Data API Lambda handler — routing and dual authorization (task 4.1).
 *
 * A single Lambda behind API Gateway (proxy integration) serves every Data API
 * route. This module is responsible for the two cross-cutting concerns that
 * apply to every route:
 *
 * 1. **Routing** — match the incoming method + path against the route table
 *    (`routes/index.ts`) and extract path parameters.
 * 2. **Dual authorization** (Requirements 9.1, 9.2, 9.3, 5.3) — derive the
 *    caller type from `requestContext`, then enforce that Cognito (webapp)
 *    callers may only touch their own `customerId`, while IAM (backend) callers
 *    may act on any customer.
 *
 * The per-route persistence logic lives in the `routes/*` modules (tasks
 * 4.3-4.6); this handler parses the request body, dispatches to the matched
 * handler, and maps thrown {@link HttpError}s and unexpected errors to the
 * appropriate HTTP status codes (400 / 403 / 404 / 500).
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

import { enforceCustomerAccess, getAuthContext } from "./auth.js";
import {
  HttpError,
  badRequest,
  errorResponse,
  jsonResponse,
  notFound,
} from "./http.js";
import { matchRoute } from "./router.js";
import { routes } from "./routes/index.js";
import type { RouteContext } from "./types.js";

/**
 * Parse the request body as JSON. Returns `undefined` when there is no body.
 *
 * @throws HttpError 400 when the body is present but not valid JSON.
 */
function parseBody(event: APIGatewayProxyEvent): unknown {
  if (event.body === null || event.body === undefined || event.body === "") {
    return undefined;
  }

  let raw = event.body;
  if (event.isBase64Encoded) {
    raw = Buffer.from(raw, "base64").toString("utf8");
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw badRequest("Request body is not valid JSON");
  }
}

/** Normalize query string parameters to a plain object (never null). */
function normalizeQuery(
  event: APIGatewayProxyEvent,
): Record<string, string | undefined> {
  return { ...(event.queryStringParameters ?? {}) };
}

/**
 * API Gateway proxy Lambda entry point. Resolves the route, enforces
 * authorization, dispatches to the route handler, and serializes the result.
 */
export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  try {
    const method = event.httpMethod;
    // CORS preflight is handled by API Gateway's MOCK integration, but answer
    // defensively if an OPTIONS request reaches the Lambda.
    if (method.toUpperCase() === "OPTIONS") {
      return jsonResponse(204, undefined, event.headers);
    }

    const path = event.path;
    const match = matchRoute(routes, method, path);
    if (!match) {
      throw notFound(`No route for ${method} ${path}`);
    }

    const { route, params } = match;

    // Authorization: derive caller type and enforce per-customer access
    // (Requirements 9.1, 9.2, 9.3, 5.3).
    const auth = getAuthContext(event);
    enforceCustomerAccess(auth, route.customerScoped, params.customerId);

    const ctx: RouteContext = {
      event,
      method: method.toUpperCase(),
      pathParameters: params,
      query: normalizeQuery(event),
      body: parseBody(event),
      auth,
    };

    const result = await route.handler(ctx);
    return jsonResponse(result.statusCode, result.body, event.headers);
  } catch (error) {
    if (error instanceof HttpError) {
      return errorResponse(error.statusCode, error.message, event.headers);
    }
    // Avoid leaking internal error detail to callers; log for diagnostics.
    console.error("Unhandled Data API error", error);
    return errorResponse(500, "Internal Server Error", event.headers);
  }
}
