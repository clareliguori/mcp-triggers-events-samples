// Pure config types + validation/normalization, with no SvelteKit `$app`
// dependency so it can be unit tested under plain Node. The runtime loader and
// origin-derived defaults live in `config.ts`, which imports from here.

export interface CognitoConfig {
  /**
   * Cognito Hosted UI domain, e.g. `auth.earthquake-agent.<parentDomain>`.
   * Used to build the `/oauth2/authorize`, `/oauth2/token`, `/logout`, and
   * `/signup` endpoint URLs. Provide the bare host (no scheme, no trailing
   * slash); a full `https://...` value is also tolerated.
   */
  readonly hostedUiDomain: string;
  /** Public (PKCE) User Pool Client id. No client secret is used. */
  readonly clientId: string;
  /** OAuth scopes requested at sign-in. Defaults to openid/email/profile. */
  readonly scopes?: readonly string[];
  /** Optional explicit redirect URI. Defaults to `<origin>/`. */
  readonly redirectUri?: string;
  /** Optional explicit post-logout URI. Defaults to `<origin>/`. */
  readonly logoutUri?: string;
}

export interface AppConfig {
  readonly cognito: CognitoConfig;
  /**
   * Base URL of the Data API (e.g. `https://api.earthquake-agent.<parentDomain>`).
   * Consumed by later tasks (config/reports pages); included here so deployment
   * only needs to manage a single runtime config file.
   */
  readonly apiBaseUrl?: string;
}

export const DEFAULT_SCOPES = ["openid", "email", "profile"] as const;

/** Remove a leading scheme and any trailing slash from a host value. */
export function stripScheme(value: string): string {
  return value.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

/**
 * Validate and normalize a raw config object, applying scope defaults. Throws
 * if required Cognito fields are missing so misconfiguration fails loudly.
 */
export function normalizeConfig(raw: AppConfig): AppConfig {
  const cognito = raw?.cognito;
  if (!cognito || typeof cognito.hostedUiDomain !== "string") {
    throw new Error("config.json: missing cognito.hostedUiDomain");
  }
  if (typeof cognito.clientId !== "string" || cognito.clientId.length === 0) {
    throw new Error("config.json: missing cognito.clientId");
  }
  return {
    ...raw,
    cognito: {
      ...cognito,
      hostedUiDomain: stripScheme(cognito.hostedUiDomain),
      scopes:
        cognito.scopes && cognito.scopes.length > 0
          ? cognito.scopes
          : DEFAULT_SCOPES,
    },
  };
}
