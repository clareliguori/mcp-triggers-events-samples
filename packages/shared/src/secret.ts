/**
 * Per-subscription Standard Webhooks secret generation.
 *
 * Per the experimental MCP Events extension webhook delivery mode, the signing
 * secret is **client-supplied per subscription**: the MCP client (the
 * Subscription Manager) generates it and passes it to the MCP server in
 * `delivery.secret` on every `events/subscribe` (create and refresh). The
 * server never generates the secret.
 *
 * The secret is a Standard Webhooks `whsec_` value: the literal prefix
 * `whsec_` followed by the base64 encoding of 24-64 random bytes (see
 * {@link WHSEC_SECRET_MIN_BYTES} / {@link WHSEC_SECRET_MAX_BYTES} and
 * {@link whsecSecretSchema}). This module is the single place that mints those
 * secrets so the Subscription Manager's registration (task 10.1) and refresh
 * (task 10.2) paths agree on the format and use a CSPRNG.
 */

import { randomBytes } from "node:crypto";

import {
  WHSEC_SECRET_MAX_BYTES,
  WHSEC_SECRET_MIN_BYTES,
  WHSEC_SECRET_PREFIX,
} from "./constants.js";

/**
 * Default number of random bytes used for a generated `whsec_` secret. Sits
 * comfortably inside the allowed 24-64 byte window and yields 256 bits of key
 * material for the HMAC-SHA256 signature.
 */
export const DEFAULT_WHSEC_SECRET_BYTES = 32;

/**
 * Generate a fresh per-subscription Standard Webhooks `whsec_` secret using a
 * cryptographically secure RNG.
 *
 * The returned value is the literal prefix `whsec_` followed by the base64
 * encoding of `byteLength` random bytes, so it satisfies the shared
 * {@link whsecSecretSchema} (and Requirement 16.6) and can be supplied directly
 * in an MCP `events/subscribe` `delivery.secret`.
 *
 * @param byteLength - How many random bytes to encode (default
 *   {@link DEFAULT_WHSEC_SECRET_BYTES}). Must be within the inclusive
 *   {@link WHSEC_SECRET_MIN_BYTES}-{@link WHSEC_SECRET_MAX_BYTES} window.
 * @throws RangeError when `byteLength` is outside the allowed window.
 */
export function generateWebhookSecret(
  byteLength: number = DEFAULT_WHSEC_SECRET_BYTES,
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
  return `${WHSEC_SECRET_PREFIX}${randomBytes(byteLength).toString("base64")}`;
}
