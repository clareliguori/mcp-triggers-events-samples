// In-memory authentication store and Hosted UI redirect orchestration.
//
// SECURITY (Requirement 10.6): JWT tokens (id/access/refresh) are held ONLY in
// module-scope JavaScript memory via Svelte 5 runes. They are never written to
// localStorage or sessionStorage, which mitigates token theft via XSS — an
// injected script cannot read tokens out of persistent storage, and a full page
// reload deliberately drops the session (the user re-authenticates against the
// still-valid Cognito Hosted UI session, which is a transparent redirect).
//
// The ONLY values that touch sessionStorage are the transient PKCE
// `code_verifier` and CSRF `state`, which must survive the redirect to the
// Hosted UI and back. They are single-use and cleared immediately after the
// authorization-code exchange. This is explicitly permitted by the task: the
// JWTs themselves stay in memory.
//
// customerId (Requirement 10.2) is derived from the id token's `sub` claim.

import { browser } from "$app/environment";
import { defaultRedirectUri, loadConfig } from "./config.js";
import type { CognitoConfig } from "./config-schema.js";
import {
  buildAuthorizeUrl,
  buildLogoutUrl,
  exchangeCodeForTokens,
  refreshTokens,
  type TokenSet,
} from "./cognito.js";
import { decodeJwt, isExpired, type JwtClaims } from "./jwt.js";
import {
  deriveCodeChallenge,
  generateCodeVerifier,
  generateState,
} from "./pkce.js";

const PKCE_VERIFIER_KEY = "eqa.pkce.verifier";
const PKCE_STATE_KEY = "eqa.pkce.state";

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface AuthState {
  status: AuthStatus;
  tokens: TokenSet | null;
  claims: JwtClaims | null;
  /** When (ms epoch) the current access/id tokens expire. */
  expiresAt: number | null;
  error: string | null;
}

// Module-scoped reactive state. Lives only in memory for the page lifetime.
const state = $state<AuthState>({
  status: "loading",
  tokens: null,
  claims: null,
  expiresAt: null,
  error: null,
});

/** Reactive view of the auth state for components. */
export const auth = {
  get status(): AuthStatus {
    return state.status;
  },
  get isAuthenticated(): boolean {
    return state.status === "authenticated";
  },
  /** The customerId, derived from the id token `sub` claim. */
  get customerId(): string | null {
    return state.claims?.sub ?? null;
  },
  get email(): string | null {
    return (state.claims?.email as string | undefined) ?? null;
  },
  get error(): string | null {
    return state.error;
  },
};

function setTokens(tokens: TokenSet): void {
  const claims = decodeJwt(tokens.idToken);
  if (!claims) {
    state.status = "unauthenticated";
    state.tokens = null;
    state.claims = null;
    state.expiresAt = null;
    state.error = "Received an undecodable id token";
    return;
  }
  state.tokens = tokens;
  state.claims = claims;
  state.expiresAt = Date.now() + tokens.expiresIn * 1000;
  state.status = "authenticated";
  state.error = null;
}

function clearTokens(): void {
  state.tokens = null;
  state.claims = null;
  state.expiresAt = null;
  state.status = "unauthenticated";
}

/** Begin the sign-in flow by redirecting to the Cognito Hosted UI. */
export async function signIn(): Promise<void> {
  await startAuthorizeRedirect({ signUp: false });
}

/** Begin the sign-up flow by redirecting to the Cognito Hosted UI signup page. */
export async function signUp(): Promise<void> {
  await startAuthorizeRedirect({ signUp: true });
}

async function startAuthorizeRedirect(opts: {
  signUp: boolean;
}): Promise<void> {
  if (!browser) {
    return;
  }
  const { cognito } = await loadConfig();
  const verifier = generateCodeVerifier();
  const challenge = await deriveCodeChallenge(verifier);
  const stateValue = generateState();

  // Persist the PKCE verifier + state across the redirect ONLY. These are not
  // secrets that grant API access; they are single-use and cleared on return.
  sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);
  sessionStorage.setItem(PKCE_STATE_KEY, stateValue);

  window.location.assign(
    buildAuthorizeUrl(cognito, {
      codeChallenge: challenge,
      state: stateValue,
      redirectUri: defaultRedirectUri(),
      signUp: opts.signUp,
    }),
  );
}

/**
 * Complete the authorization code flow if the current URL carries a `code`
 * (and matching `state`). On success, tokens are stored in memory and the
 * OAuth query params are stripped from the URL. When no `code` is present this
 * attempts a silent restore via refresh token (none in memory on a fresh load),
 * leaving the user unauthenticated so the UI can prompt sign-in.
 *
 * Returns true when the user ends up authenticated.
 */
export async function handleRedirectCallback(
  url: URL = browser
    ? new URL(window.location.href)
    : new URL("http://localhost/"),
): Promise<boolean> {
  if (!browser) {
    return false;
  }
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    state.error = url.searchParams.get("error_description") ?? oauthError;
    state.status = "unauthenticated";
    clearPkceStorage();
    cleanOAuthParams(url);
    return false;
  }

  if (!code) {
    // No redirect in progress: nothing to restore (tokens are memory-only).
    state.status = "unauthenticated";
    return false;
  }

  const verifier = sessionStorage.getItem(PKCE_VERIFIER_KEY);
  const expectedState = sessionStorage.getItem(PKCE_STATE_KEY);
  clearPkceStorage();

  if (!verifier || !expectedState || returnedState !== expectedState) {
    state.error = "Invalid or missing PKCE state on callback";
    state.status = "unauthenticated";
    cleanOAuthParams(url);
    return false;
  }

  try {
    const { cognito } = await loadConfig();
    const tokens = await exchangeCodeForTokens(cognito, {
      code,
      codeVerifier: verifier,
      redirectUri: defaultRedirectUri(),
    });
    setTokens(tokens);
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    state.status = "unauthenticated";
  } finally {
    cleanOAuthParams(url);
  }
  return state.status === "authenticated";
}

/** Sign out: drop in-memory tokens and redirect to the Hosted UI logout. */
export async function signOut(): Promise<void> {
  clearTokens();
  if (!browser) {
    return;
  }
  const { cognito } = await loadConfig();
  window.location.assign(
    buildLogoutUrl(cognito, { logoutUri: defaultRedirectUri() }),
  );
}

/**
 * Return a valid bearer token for Data API calls, refreshing it first if it is
 * expired or near expiry. Returns null when the user is not authenticated or
 * refresh fails.
 *
 * This returns the Cognito **id token**, not the access token: the Data API's
 * API Gateway Cognito User Pool Authorizer validates id tokens (it checks the
 * `token_use` claim and rejects access tokens with 401). The id token also
 * carries the `email`/profile claims the API may use. Components calling the
 * Data API should use this to obtain the `Authorization: Bearer` credential.
 */
export async function getValidAccessToken(): Promise<string | null> {
  if (!state.tokens || !state.claims) {
    return null;
  }
  const expiringSoon =
    state.expiresAt !== null && state.expiresAt <= Date.now() + 60_000;
  if (expiringSoon || isExpired(state.claims)) {
    const ok = await tryRefresh();
    if (!ok) {
      return null;
    }
  }
  return state.tokens?.idToken ?? null;
}

async function tryRefresh(config?: CognitoConfig): Promise<boolean> {
  const refreshToken = state.tokens?.refreshToken;
  if (!refreshToken) {
    clearTokens();
    return false;
  }
  try {
    const cognito = config ?? (await loadConfig()).cognito;
    const tokens = await refreshTokens(cognito, refreshToken);
    setTokens(tokens);
    return true;
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    clearTokens();
    return false;
  }
}

function clearPkceStorage(): void {
  sessionStorage.removeItem(PKCE_VERIFIER_KEY);
  sessionStorage.removeItem(PKCE_STATE_KEY);
}

function cleanOAuthParams(url: URL): void {
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  url.searchParams.delete("error");
  url.searchParams.delete("error_description");
  window.history.replaceState({}, "", url.pathname + url.search + url.hash);
}
