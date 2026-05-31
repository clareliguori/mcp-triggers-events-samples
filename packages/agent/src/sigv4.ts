/**
 * IAM SigV4-signed HTTP helper for the Serverless Agent (shared by `router.ts`
 * and `briefing.ts`).
 *
 * The agent calls the Data API over IAM-authenticated HTTPS (Requirement 17.7):
 * - `router.ts` resolves a subscription to a customer with
 *   `GET /subscriptions/{id}` (task 9.3), and
 * - `briefing.ts`'s `save_report` tool callback persists a report with
 *   `POST /customers/{customerId}/reports` (task 9.8).
 *
 * Both sign the request for the `execute-api` service using the Lambda
 * execution role's credentials (via the default provider chain) and deliver it
 * with the global `fetch` (Node 20+). Factoring the signing here keeps the two
 * call sites identical and avoids duplicating the SigV4 plumbing.
 */

import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@smithy/signature-v4";
import type { HttpRequest } from "@smithy/types";

/** A SigV4-signed HTTP request to deliver to an `execute-api` endpoint. */
export interface SignedFetchRequest {
  /** HTTP method (e.g. `GET`, `POST`). */
  method: string;
  /** Absolute request URL. */
  url: string;
  /** Optional request body (already serialized, e.g. JSON text). */
  body?: string;
  /**
   * Optional extra headers to include in signing and delivery (e.g.
   * `accept`, `content-type`). The `host` header is set automatically.
   */
  headers?: Record<string, string>;
}

/** The downstream HTTP status and raw response body text. */
export interface SignedFetchResponse {
  /** Downstream HTTP status code. */
  statusCode: number;
  /** Raw response body text (may be empty). */
  body: string;
}

/** Resolve the signing region from the Lambda environment. */
function signingRegion(): string {
  return (
    process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1"
  );
}

/**
 * SigV4-sign a request for the `execute-api` service and deliver it with the
 * global `fetch`. Credentials come from the Lambda execution role via the
 * default provider chain (Requirement 17.7).
 *
 * @returns the downstream status code and raw response body text.
 */
export async function signedFetch(
  request: SignedFetchRequest,
): Promise<SignedFetchResponse> {
  const url = new URL(request.url);

  // SigV4 sets the `host` header during signing; provide it explicitly too so
  // it is part of the signed header set.
  const headers: Record<string, string> = {
    host: url.host,
    ...request.headers,
  };

  // Preserve any query string in the signed request.
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  const signer = new SignatureV4({
    service: "execute-api",
    region: signingRegion(),
    credentials: defaultProvider(),
    sha256: Sha256,
  });

  const toSign: HttpRequest = {
    method: request.method,
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname,
    headers,
    body: request.body,
    ...(Object.keys(query).length > 0 && { query }),
  };

  const signed = await signer.sign(toSign);

  const response = await fetch(request.url, {
    method: request.method,
    headers: signed.headers,
    ...(request.body !== undefined && { body: request.body }),
  });

  return { statusCode: response.status, body: await response.text() };
}
