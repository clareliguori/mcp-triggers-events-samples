/**
 * The Data API route table.
 *
 * Declares every Data API route as a {@link RouteDefinition} mapping a method +
 * path pattern to its handler. The handler module matches an incoming request
 * against this table (first match wins, declaration order matters) and then
 * applies authorization before dispatching.
 *
 * More specific patterns are declared before less specific ones (e.g.
 * `/customers/:customerId/reports/:reportId` before
 * `/customers/:customerId/reports`) so the router resolves the intended route.
 */

import { deleteConfig, getConfig, putConfig } from "./config.js";
import { getReport, listReports, createReport } from "./reports.js";
import { getSessionMessages } from "./session.js";
import {
  createSubscription,
  getSubscription,
  listSubscriptions,
  putSubscription,
} from "./subscriptions.js";
import { triggerBriefing } from "./trigger.js";
import { isCustomerScoped } from "../router.js";
import type { RouteDefinition, RouteHandler } from "../types.js";

/** Build a {@link RouteDefinition}, deriving `customerScoped` from the pattern. */
function route(
  method: string,
  pattern: string,
  handler: RouteHandler,
): RouteDefinition {
  return {
    method: method.toUpperCase(),
    pattern,
    customerScoped: isCustomerScoped(pattern),
    handler,
  };
}

/**
 * The route table. Order matters: `:reportId` is declared before the reports
 * collection so the more specific path is matched first (the router compares
 * segment counts, so this is also disambiguated by length, but declaration
 * order keeps intent clear).
 */
export const routes: RouteDefinition[] = [
  // --- Customer config (Cognito) ------------------------------------------
  route("GET", "/customers/:customerId/config", getConfig),
  route("PUT", "/customers/:customerId/config", putConfig),
  route("DELETE", "/customers/:customerId/config", deleteConfig),

  // --- Reports ------------------------------------------------------------
  route("GET", "/customers/:customerId/reports/:reportId", getReport),
  route("GET", "/customers/:customerId/reports", listReports),
  route("POST", "/customers/:customerId/reports", createReport),

  // --- Session messages (read-only) ---------------------------------------
  route("GET", "/customers/:customerId/session/messages", getSessionMessages),

  // --- Customer-scoped subscriptions --------------------------------------
  route("GET", "/customers/:customerId/subscriptions", listSubscriptions),
  route("POST", "/customers/:customerId/subscriptions", createSubscription),

  // --- Subscription lookup by id (backend / IAM) --------------------------
  route("GET", "/subscriptions/:subscriptionId", getSubscription),
  route("PUT", "/subscriptions/:subscriptionId", putSubscription),

  // --- Manual briefing trigger (Cognito) ----------------------------------
  route("POST", "/trigger-briefing/:customerId", triggerBriefing),
];
