// Public surface of the auth module.
//
// Usage from components/routes:
//   import { auth, signIn, signOut, handleRedirectCallback } from "$lib/auth";
//
// - `auth` is a reactive view (status, isAuthenticated, customerId, email).
// - Call `handleRedirectCallback()` once on app load to complete a returning
//   OAuth redirect, then `signIn()`/`signUp()`/`signOut()` to drive the flow.
// - `getValidAccessToken()` yields a fresh Bearer token for Data API calls,
//   transparently refreshing when near expiry.

export {
  auth,
  signIn,
  signUp,
  signOut,
  handleRedirectCallback,
  getValidAccessToken,
  type AuthStatus,
} from "./store.svelte.js";

export {
  loadConfig,
  resetConfigCache,
  type AppConfig,
  type CognitoConfig,
} from "./config.js";
export { decodeJwt, isExpired, type JwtClaims } from "./jwt.js";
export {
  buildAuthorizeUrl,
  buildLogoutUrl,
  exchangeCodeForTokens,
  refreshTokens,
  type TokenSet,
} from "./cognito.js";
export {
  generateCodeVerifier,
  deriveCodeChallenge,
  generateState,
  base64UrlEncode,
} from "./pkce.js";
