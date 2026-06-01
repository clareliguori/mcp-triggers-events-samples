// Runtime configuration loader for the webapp.
//
// CONFIG INJECTION STRATEGY
// -------------------------
// This is a static SvelteKit SPA (adapter-static, ssr=false) served from S3 via
// CloudFront. Rather than baking environment values into the bundle at build
// time (Vite `PUBLIC_*` vars), the app loads a small `config.json` at runtime
// from the site root. This lets the same built artifact be deployed to any
// environment: the CDK WebappStack's asset deployment writes the real Cognito
// values (User Pool Client id, Hosted UI custom domain) into `config.json` when
// it publishes the bucket, while the committed `static/config.json` carries
// local/dev placeholders so `npm run dev` renders without a build step.
//
// The redirect/logout URIs are derived from the current browser origin by
// default (so they line up with the Cognito callback URLs registered in
// AuthStack: `https://app.<domain>/` and `http://localhost:5173/`). They can be
// overridden in `config.json` if needed.
//
// The pure types + validation live in `config-schema.ts` (no `$app` import) so
// they can be unit tested without the SvelteKit build pipeline.

import { base } from "$app/paths";
import { browser } from "$app/environment";
import {
  normalizeConfig,
  type AppConfig,
  type CognitoConfig,
} from "./config-schema.js";

export type { AppConfig, CognitoConfig } from "./config-schema.js";
export { normalizeConfig, stripScheme } from "./config-schema.js";

let cached: AppConfig | null = null;

/**
 * Load `config.json` from the site root. The result is memoized for the page
 * lifetime. A custom `fetchFn` may be supplied for testing.
 */
export async function loadConfig(
  fetchFn: typeof fetch = fetch,
): Promise<AppConfig> {
  if (cached) {
    return cached;
  }
  const res = await fetchFn(`${base}/config.json`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(
      `Failed to load runtime config (${String(res.status)} ${res.statusText})`,
    );
  }
  const parsed = (await res.json()) as AppConfig;
  cached = normalizeConfig(parsed);
  return cached;
}

/** Reset the memoized config. Intended for tests. */
export function resetConfigCache(): void {
  cached = null;
}

/** The default OAuth redirect URI: the current origin with a trailing slash. */
export function defaultRedirectUri(): string {
  if (!browser) {
    return "/";
  }
  return `${window.location.origin}/`;
}
