/**
 * Per-subscription Standard Webhooks secret generation for the Subscription
 * Manager (the MCP Client/Host).
 *
 * Per the experimental MCP Events extension webhook delivery mode, the
 * Subscription Manager is the party that OWNS webhook secret generation
 * (Requirement 14.6, design Component 5). Each `events/subscribe` call carries a
 * REQUIRED, client-supplied `delivery.secret`: a Standard Webhooks symmetric
 * secret in `whsec_` format (the literal prefix `whsec_` followed by the base64
 * encoding of 24-64 random bytes). The MCP servers never generate it.
 *
 * This module is the single source of that generation. It is factored into its
 * own file (rather than living inside `register.ts`) so the scheduled-refresh
 * path (`refresh.ts`, task 10.2 — which MAY rotate the secret on refresh) can
 * reuse the exact same generator without duplicating the format rules.
 *
 * The generated value is validated by the shared `whsecSecretSchema` and is
 * what the Data API field-encrypts at its storage boundary and what the MCP
 * servers use to sign each delivery. It is produced with a CSPRNG
 * (`node:crypto.randomBytes`).
 */

import { randomBytes } from "node:crypto";

import {
  WHSEC_SECRET_MAX_BYTES,
  WHSEC_SECRET_MIN_BYTES,
  WHSEC_SECRET_PREFIX,
} from "@mcp-events/shared";

/**
 * Default number of random bytes used for a generated secret. 32 bytes
 * (256 bits) is a comfortable middle of the allowed 24-64 byte window and
 * matches the entropy used elsewhere in the system's tests.
 */
export const DEFAULT_SECRET_BYTES = 32;

/**
 * Generate a fresh per-subscription Standard Webhooks `whsec_` secret using a
 * CSPRNG (Requirement 14.6).
 *
 * The result is the literal prefix `whsec_` followed by the base64 encoding of
 * `byteLength` cryptographically random bytes, conforming to the format the
 * shared `whsecSecretSchema` enforces (prefix + base64 of 24-64 bytes).
 *
 * @param byteLength - Number of random bytes to encode. Must be within the
 *   allowed Standard Webhooks bounds (24-64 inclusive). Defaults to
 *   {@link DEFAULT_SECRET_BYTES}.
 * @throws RangeError when `byteLength` is outside the 24-64 byte bounds.
 */
export function generateWebhookSecret(
  byteLength: number = DEFAULT_SECRET_BYTES,
): string {
  if (
    !Number.isInteger(byteLength) ||
    byteLength < WHSEC_SECRET_MIN_BYTES ||
    byteLength > WHSEC_SECRET_MAX_BYTES
  ) {
    throw new RangeError(
      `whsec_ secret byte length must be an integer in [${WHSEC_SECRET_MIN_BYTES}, ${WHSEC_SECRET_MAX_BYTES}]`,
    );
  }
  const body = randomBytes(byteLength).toString("base64");
  return `${WHSEC_SECRET_PREFIX}${body}`;
}
