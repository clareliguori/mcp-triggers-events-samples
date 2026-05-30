/**
 * HTTP helpers for the Data API Lambda: a typed error class that route
 * handlers throw to short-circuit with a specific status code, and helpers
 * for building API Gateway proxy responses with the correct CORS headers.
 *
 * The Data API restricts CORS to the CloudFront webapp origin only
 * (Requirement 17.2); the allowed origin is supplied via the `ALLOWED_ORIGIN`
 * environment variable by the CDK stack.
 */

import type { APIGatewayProxyResult } from "aws-lambda";

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

/** Base CORS headers shared by every response. */
function corsHeaders(): Record<string, string> {
  const allowedOrigin = process.env.ALLOWED_ORIGIN ?? "*";
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Credentials": "true",
  };
}

/** Build an API Gateway proxy response with a JSON body. */
export function jsonResponse(
  statusCode: number,
  body?: unknown,
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: corsHeaders(),
    body: body === undefined ? "" : JSON.stringify(body),
  };
}

/** Build a JSON error response of the shape `{ "error": message }`. */
export function errorResponse(
  statusCode: number,
  message: string,
): APIGatewayProxyResult {
  return jsonResponse(statusCode, { error: message });
}
