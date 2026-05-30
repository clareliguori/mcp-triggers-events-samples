/**
 * Route matching for the Data API Lambda (task 4.1).
 *
 * Routes are declared as `METHOD /literal/:param/...` patterns. A request is
 * matched by splitting both the pattern and the request path into segments and
 * comparing them segment-by-segment; `:name` segments capture a path parameter.
 *
 * The first matching route (in declaration order) wins, so more specific
 * patterns should be declared before more general ones. Matching is exact on
 * segment count — there is no greedy/proxy matching here (the API Gateway
 * `{proxy+}` fallback exists only to attach IAM auth; this handler still
 * resolves the concrete route).
 */

import type { RouteDefinition, RouteMatch } from "./types.js";

/** Split a URL path into non-empty segments. `/a/b/` -> `["a", "b"]`. */
function segments(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

/** Whether a pattern segment is a `:param` placeholder. */
function isParam(segment: string): boolean {
  return segment.startsWith(":");
}

/** Derive whether a pattern is customer-scoped (contains `:customerId`). */
export function isCustomerScoped(pattern: string): boolean {
  return segments(pattern).some((s) => s === ":customerId");
}

/**
 * Attempt to match a single pattern against a request path, returning the
 * captured path parameters or `null` when the path does not match.
 */
function matchPattern(
  pattern: string,
  pathSegments: string[],
): Record<string, string> | null {
  const patternSegments = segments(pattern);
  if (patternSegments.length !== pathSegments.length) {
    return null;
  }

  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegments.length; i += 1) {
    const patternSegment = patternSegments[i];
    const pathSegment = pathSegments[i];
    if (isParam(patternSegment)) {
      params[patternSegment.slice(1)] = decodeURIComponent(pathSegment);
    } else if (patternSegment !== pathSegment) {
      return null;
    }
  }
  return params;
}

/**
 * Match a method + path against the route table. Returns the first route whose
 * method and pattern match, along with the captured path parameters, or `null`
 * when no route matches.
 *
 * @param routes - The route table (declaration order matters).
 * @param method - Upper-case HTTP method.
 * @param path - The request path (e.g. `/customers/abc/config`).
 */
export function matchRoute(
  routes: RouteDefinition[],
  method: string,
  path: string,
): RouteMatch | null {
  const pathSegments = segments(path);
  const upperMethod = method.toUpperCase();

  for (const route of routes) {
    if (route.method !== upperMethod) {
      continue;
    }
    const params = matchPattern(route.pattern, pathSegments);
    if (params !== null) {
      return { route, params };
    }
  }
  return null;
}
