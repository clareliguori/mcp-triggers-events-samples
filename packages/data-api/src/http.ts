/**
 * HTTP helpers for the Data API Lambda: a typed error class that route
 * handlers throw to short-circuit with a specific status code, and helpers
 * for building API Gateway proxy responses with the correct CORS headers.
 *
 * The Data API restricts CORS to an allowlist of origins (Requirement 17.2).
 * The allowlist is supplied via the `ALLOWED_ORIGIN` environment variable by
 * the CDK stack as a comma-separated list. In production this is the single
 * CloudFront webapp origin; for local development the stack can additionally
 * include `http://localhost:5173` (opt-in via CDK context) so the webapp dev
 * server can call a deployed Data API.
 *
 * Because responses set `Access-Control-Allow-Credentials: true`, the CORS spec
 * forbids a wildcard `Access-Control-Allow-Origin`; a single concrete origin
 * must be echoed back. We therefore reflect the request's `Origin` header when
 * (and only when) it is on the allowlist, instead of emitting a fixed value.
 */

import type {
  APIGatewayProxyEventHeaders,
  APIGatewayProxyResult,
} from "aws-lambda";

/**
 * An error carrying an HTTP status code. Route handlers (and the auth /
 * routing layer) throw this to return a specific status (400/403/404/...) with
 * a JSON error body. Anything else thrown becomes a 500.
 */
export class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

/** 400 Bad Request — malformed input / validation failure (Requirement 9.4). */
export function badRequest(message = "Bad Request"): HttpError {
  return new HttpError(400, message);
}

/** 403 Forbidden — authorization failure (Requirements 5.3, 9.2). */
export function forbidden(message = "Forbidden"): HttpError {
  return new HttpError(403, message);
}

/** 404 Not Found — resource or route does not exist. */
export function notFound(message = "Not Found"): HttpError {
  return new HttpError(404, message);
}

/** Parse the `ALLOWED_ORIGIN` env var into a list of allowed origins. */
function allowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGIN ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/** Case-insensitively read the request `Origin` header, if present. */
function requestOrigin(
  headers: APIGatewayProxyEventHeaders | undefined,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "origin" && typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

/**
 * Base CORS headers shared by every response.
 *
 * Reflects the request `Origin` when it is on the allowlist (required because
 * credentialed responses cannot use a wildcard origin). When there is no
 * request origin (for example a SigV4 backend caller) or it is not allowed, the
 * first configured origin is returned so browsers from disallowed origins are
 * not granted access. Falls back to `*` only when no allowlist is configured
 * (local unit tests without the env var set).
 */
function corsHeaders(
  headers?: APIGatewayProxyEventHeaders,
): Record<string, string> {
  const origins = allowedOrigins();
  const origin = requestOrigin(headers);

  let allowOrigin: string;
  if (origins.length === 0) {
    allowOrigin = "*";
  } else if (origin && origins.includes(origin)) {
    allowOrigin = origin;
  } else {
    allowOrigin = origins[0];
  }

  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Credentials": "true",
    // Caches must vary on Origin since the allowed value is request-dependent.
    Vary: "Origin",
  };
}

/** Build an API Gateway proxy response with a JSON body. */
export function jsonResponse(
  statusCode: number,
  body?: unknown,
  requestHeaders?: APIGatewayProxyEventHeaders,
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: corsHeaders(requestHeaders),
    body: body === undefined ? "" : JSON.stringify(body),
  };
}

/** Build a JSON error response of the shape `{ "error": message }`. */
export function errorResponse(
  statusCode: number,
  message: string,
  requestHeaders?: APIGatewayProxyEventHeaders,
): APIGatewayProxyResult {
  return jsonResponse(statusCode, { error: message }, requestHeaders);
}
