// PKCE (Proof Key for Code Exchange, RFC 7636) helpers for the Cognito
// authorization code grant used by this public SPA client.
//
// The `code_verifier` is a high-entropy random string; the `code_challenge` is
// its base64url-encoded SHA-256 digest. We send the challenge on the authorize
// redirect and the verifier on the token exchange, proving the same client that
// started the flow is completing it without needing a client secret.
//
// These are pure functions over the Web Crypto API so they can be unit tested
// in isolation (the in-memory token store and redirect orchestration live
// elsewhere).

/** Base64url-encode bytes (RFC 4648 §5, no padding). */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Generate a PKCE `code_verifier`: a URL-safe random string of 43-128 chars per
 * RFC 7636. 32 random bytes base64url-encoded yields 43 chars.
 */
export function generateCodeVerifier(
  cryptoImpl: Crypto = globalThis.crypto,
): string {
  const bytes = new Uint8Array(32);
  cryptoImpl.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * Derive the S256 `code_challenge` from a `code_verifier`: base64url of the
 * SHA-256 digest of the ASCII verifier.
 */
export async function deriveCodeChallenge(
  verifier: string,
  cryptoImpl: Crypto = globalThis.crypto,
): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await cryptoImpl.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

/** Generate an opaque random `state` value for CSRF protection on the redirect. */
export function generateState(cryptoImpl: Crypto = globalThis.crypto): string {
  const bytes = new Uint8Array(16);
  cryptoImpl.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}
