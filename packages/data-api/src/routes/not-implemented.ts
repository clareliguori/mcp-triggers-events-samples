/**
 * Shared placeholder for route handlers whose persistence logic lands in a
 * later task (4.3-4.6). Returns HTTP 501 Not Implemented so the routing and
 * authorization skeleton (task 4.1) is fully exercisable and unit-testable
 * without prematurely implementing storage access.
 *
 * Each stub names the route it stands in for, making it obvious in tests and
 * logs which handler is still pending.
 */

import type { ApiResult } from "../types.js";

/** Build a 501 result for a route that is routed + authorized but not yet implemented. */
export function notImplemented(route: string): ApiResult {
  return {
    statusCode: 501,
    body: { error: `Not Implemented: ${route}` },
  };
}
