// Cognito Hosted UI OAuth endpoint helpers.
//
// Builds the authorize/signup/logout redirect URLs and performs the token
// endpoint exchanges (authorization code -> tokens, refresh_token -> tokens)
// for the PKCE public client. These functions are pure with respect to their
// inputs (they take a `CognitoConfig` and a `fetch`), keeping the redirect
// orchestration and in-memory token storage in `store.ts`.

import type { CognitoConfig } from "./config-schema.js";

/** The set of tokens returned by the Cognito token endpoint. */
export interface TokenSet {
  /** OIDC id token (JWT). Carries the `sub` claim used as customerId. */
  idToken: string;
  /** OAuth access token (JWT). Sent as the Bearer credential to the Data API. */
  accessToken: string;
  /**
   * Refresh token. Present on the authorization-code exchange; Cognito does NOT
   * return a new refresh token on refresh, so the original is retained.
   */
  refreshToken?: string;
  /** Lifetime of the access/id tokens in seconds. */
  expiresIn: number;
  tokenType: string;
}

interface RawTokenResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
}

/** Base URL (scheme + host) of the Hosted UI for the configured domain. */
export function hostedUiBaseUrl(config: CognitoConfig): string {
  return `https://${config.hostedUiDomain}`;
}

function resolveRedirectUri(config: CognitoConfig, fallback: string): string {
  return config.redirectUri ?? fallback;
}

function resolveLogoutUri(config: CognitoConfig, fallback: string): string {
  return config.logoutUri ?? config.redirectUri ?? fallback;
}

/**
 * Build the Hosted UI authorization URL for the authorization code grant with
 * PKCE. `redirectUri` defaults to the configured/derived value.
 */
export function buildAuthorizeUrl(
  config: CognitoConfig,
  params: {
    codeChallenge: string;
    state: string;
    redirectUri: string;
    /** When true, route to the Hosted UI sign-up screen instead of sign-in. */
    signUp?: boolean;
  },
): string {
  const endpoint = params.signUp ? "/signup" : "/oauth2/authorize";
  const url = new URL(`${hostedUiBaseUrl(config)}${endpoint}`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set(
    "redirect_uri",
    resolveRedirectUri(config, params.redirectUri),
  );
  url.searchParams.set(
    "scope",
    (config.scopes ?? ["openid", "email", "profile"]).join(" "),
  );
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", params.state);
  return url.toString();
}

/**
 * Build the Hosted UI logout URL. Cognito clears its session and redirects back
 * to `logout_uri` (which must be registered in the User Pool Client).
 */
export function buildLogoutUrl(
  config: CognitoConfig,
  params: { logoutUri: string },
): string {
  const url = new URL(`${hostedUiBaseUrl(config)}/logout`);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set(
    "logout_uri",
    resolveLogoutUri(config, params.logoutUri),
  );
  return url.toString();
}

function mapTokenResponse(raw: RawTokenResponse): TokenSet {
  if (!raw.access_token || !raw.id_token) {
    throw new Error(
      raw.error_description ??
        raw.error ??
        "Cognito token endpoint returned no tokens",
    );
  }
  return {
    idToken: raw.id_token,
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresIn: raw.expires_in ?? 3600,
    tokenType: raw.token_type ?? "Bearer",
  };
}

async function postToken(
  config: CognitoConfig,
  body: URLSearchParams,
  fetchFn: typeof fetch,
): Promise<TokenSet> {
  const res = await fetchFn(`${hostedUiBaseUrl(config)}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const raw = (await res.json().catch(() => ({}))) as RawTokenResponse;
  if (!res.ok) {
    throw new Error(
      raw.error_description ??
        raw.error ??
        `Cognito token endpoint failed (${String(res.status)})`,
    );
  }
  return mapTokenResponse(raw);
}

/** Exchange an authorization code (+ PKCE verifier) for a token set. */
export async function exchangeCodeForTokens(
  config: CognitoConfig,
  params: { code: string; codeVerifier: string; redirectUri: string },
  fetchFn: typeof fetch = fetch,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    code: params.code,
    redirect_uri: resolveRedirectUri(config, params.redirectUri),
    code_verifier: params.codeVerifier,
  });
  return postToken(config, body, fetchFn);
}

/**
 * Exchange a refresh token for a fresh access/id token pair. Cognito does not
 * return a new refresh token, so the caller retains the existing one.
 */
export async function refreshTokens(
  config: CognitoConfig,
  refreshToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.clientId,
    refresh_token: refreshToken,
  });
  const tokens = await postToken(config, body, fetchFn);
  return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
}
