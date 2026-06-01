// Minimal JWT claim decoding.
//
// The SPA only needs to READ claims (notably `sub`, which is the customerId, and
// `exp` for refresh scheduling) from the Cognito-issued id/access tokens. It
// does NOT verify the signature — that is the job of the API Gateway Cognito
// authorizer, which rejects forged or tampered tokens server-side. Decoding here
// is purely to drive UI state and derive the customerId for request paths.

export interface JwtClaims {
  /** Subject: the Cognito User Pool user id. Used as `customerId`. */
  sub: string;
  /** Expiry (seconds since epoch). */
  exp?: number;
  /** Issued-at (seconds since epoch). */
  iat?: number;
  email?: string;
  [claim: string]: unknown;
}

/** Base64url-decode a string to its UTF-8 representation. */
function base64UrlDecode(segment: string): string {
  const padded = segment
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(segment.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Decode the claims (payload) of a JWT without verifying its signature. Returns
 * `null` for malformed input rather than throwing, so callers can treat an
 * undecodable token as "not authenticated".
 */
export function decodeJwt(token: string): JwtClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  try {
    const claims = JSON.parse(base64UrlDecode(parts[1])) as JwtClaims;
    if (typeof claims.sub !== "string" || claims.sub.length === 0) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

/**
 * Return true if the token is expired (or expires within `skewSeconds`).
 * Tokens without an `exp` claim are treated as non-expiring.
 */
export function isExpired(
  claims: JwtClaims,
  skewSeconds = 30,
  nowMs: number = Date.now(),
): boolean {
  if (typeof claims.exp !== "number") {
    return false;
  }
  return claims.exp * 1000 <= nowMs + skewSeconds * 1000;
}
