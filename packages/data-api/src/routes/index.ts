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

import { deleteConfig, getConfig, listCustomers, putConfig } from "./config.js";
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

  // --- Backend config read (IAM) ------------------------------------------
  // The Serverless Agent reads a customer's config over IAM SigV4. The webapp
  // /customers/:customerId/config route above is Cognito-only, and in API
  // Gateway explicit resources win over the {proxy+} fallback, so a signed
  // backend read of that path is intercepted by the Cognito method and 401s.
  // This explicit backend path is declared with IAM auth in the CDK stack and
  // Backend (IAM) list-all-customers route for the Subscription Manager refresh.
  route("GET", "/backend/customers", listCustomers),

  // reuses the same getConfig handler. It is customerScoped (contains
  // :customerId), so enforceCustomerAccess applies — IAM callers may read any
  // customer (Requirement 9.3).
  route("GET", "/backend/customers/:customerId/config", getConfig),

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
