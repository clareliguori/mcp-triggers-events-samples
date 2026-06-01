// Authenticated Data API client.
//
// A small, general-purpose HTTP helper for calling the Data API
// (`https://api.earthquake-agent.<parentDomain>`). It resolves the base URL
// from the runtime `config.json` (see `$lib/auth/config`) and attaches a fresh
// Cognito access token as a `Bearer` Authorization header on every request,
// transparently refreshing the token when it is near expiry via
// `getValidAccessToken()`.
//
// This module is intentionally endpoint-agnostic so the config page (task 12.3),
// the reports view (task 12.4), and the conversation history view (task 12.5)
// can all share it. Callers build the path (e.g.
// `/customers/${customerId}/config`) and supply a typed body/response.

import { getValidAccessToken } from "$lib/auth";
import { loadConfig } from "$lib/auth/config.js";

/** HTTP methods used by the Data API surface. */
export type HttpMethod = "GET" | "PUT" | "POST" | "DELETE";

/** Options for a single Data API request. */
export interface ApiRequestOptions<TBody = unknown> {
  /** Optional JSON request body. Serialized with `JSON.stringify`. */
  body?: TBody;
  /** Optional query-string parameters. Undefined/null values are skipped. */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Optional AbortSignal so callers can cancel in-flight polling requests. */
  signal?: AbortSignal;
  /** Override the fetch implementation (tests). Defaults to global `fetch`. */
  fetchFn?: typeof fetch;
}

/**
 * Error thrown when a Data API request fails: either authentication is missing
 * (no valid token / not signed in) or the server returned a non-2xx response.
 * Carries the HTTP `status` (0 when the failure is client-side) so callers can
 * branch on 401/403/404, and the parsed server error `message` when present.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Join the configured API base URL with a path and optional query string. */
function buildUrl(
  baseUrl: string,
  path: string,
  query?: ApiRequestOptions["query"],
): string {
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${trimmedBase}${normalizedPath}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

/**
 * Extract a human-readable error message from a failed response. The Data API
 * returns `{ "message": "..." }` (or `{ "error": "..." }`) JSON bodies; fall
 * back to the status text when the body is empty or unparseable.
 */
async function readErrorMessage(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) {
      return res.statusText || `Request failed with status ${res.status}`;
    }
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string };
      return parsed.message ?? parsed.error ?? text;
    } catch {
      return text;
    }
  } catch {
    return res.statusText || `Request failed with status ${res.status}`;
  }
}

/**
 * Perform an authenticated Data API request and return the parsed JSON body.
 *
 * Obtains a valid Bearer token (refreshing if needed); throws {@link ApiError}
 * with status 0 when the user is not authenticated. Resolves the API base URL
 * from the runtime config. Throws {@link ApiError} carrying the HTTP status and
 * server message on a non-2xx response. A `204 No Content` (or empty body)
 * resolves to `undefined`.
 */
export async function apiRequest<TResponse = unknown, TBody = unknown>(
  method: HttpMethod,
  path: string,
  options: ApiRequestOptions<TBody> = {},
): Promise<TResponse> {
  const fetchFn = options.fetchFn ?? fetch;

  const token = await getValidAccessToken();
  if (!token) {
    throw new ApiError("Not authenticated", 0);
  }

  const { apiBaseUrl } = await loadConfig(fetchFn);
  if (!apiBaseUrl) {
    throw new ApiError("config.json: missing apiBaseUrl", 0);
  }

  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${token}`,
  };

  let serializedBody: string | undefined;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    serializedBody = JSON.stringify(options.body);
  }

  const res = await fetchFn(buildUrl(apiBaseUrl, path, options.query), {
    method,
    headers,
    body: serializedBody,
    signal: options.signal,
  });

  if (!res.ok) {
    throw new ApiError(await readErrorMessage(res), res.status);
  }

  if (res.status === 204) {
    return undefined as TResponse;
  }
  const text = await res.text();
  if (!text) {
    return undefined as TResponse;
  }
  return JSON.parse(text) as TResponse;
}

/** Convenience wrappers for the common HTTP verbs. */
export const api = {
  get: <TResponse = unknown>(
    path: string,
    options?: ApiRequestOptions,
  ): Promise<TResponse> => apiRequest<TResponse>("GET", path, options),
  put: <TResponse = unknown, TBody = unknown>(
    path: string,
    body: TBody,
    options?: Omit<ApiRequestOptions<TBody>, "body">,
  ): Promise<TResponse> =>
    apiRequest<TResponse, TBody>("PUT", path, { ...options, body }),
  post: <TResponse = unknown, TBody = unknown>(
    path: string,
    body?: TBody,
    options?: Omit<ApiRequestOptions<TBody>, "body">,
  ): Promise<TResponse> =>
    apiRequest<TResponse, TBody>("POST", path, { ...options, body }),
  delete: <TResponse = unknown>(
    path: string,
    options?: ApiRequestOptions,
  ): Promise<TResponse> => apiRequest<TResponse>("DELETE", path, options),
};
