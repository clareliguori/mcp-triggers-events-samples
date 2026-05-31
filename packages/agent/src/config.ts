/**
 * CustomerConfig loading for the Serverless Agent (task 9.10).
 *
 * Once the router (task 9.3) resolves an event's `subscriptionId` to a
 * `customerId`, the handler needs that customer's {@link CustomerConfig}
 * (`briefingPrompt`, `displayName`, ...) before it can build the agent and
 * process the event (Requirements 4.4, 4.5, 11.2). The config lives in the Data
 * API, so this module loads it with `GET /customers/{customerId}/config` over
 * an IAM SigV4-signed HTTPS request — the same signing approach the router's
 * subscription lookup uses (Requirement 17.7). Factoring it here keeps the
 * handler thin and mirrors the `SubscriptionLookup` test seam in `router.ts`.
 *
 * Error handling (design Error Scenario 8): a `customerId` with no config (the
 * Data API returns 404) is treated as **handled, not retryable** — the customer
 * was deleted or never existed, so retrying cannot help. {@link
 * loadCustomerConfig} returns `null` in that case and the handler logs and
 * drops the message (the Subscription Manager later unsubscribes the orphaned
 * subscription). A transient Data API failure (timeout, 5xx) or an unexpected
 * 200 body that fails schema validation is surfaced as a thrown error so the
 * handler lets the SQS message return to the queue for retry.
 */

import type { CustomerConfig } from "@mcp-events/shared";
import { customerConfigSchema } from "@mcp-events/shared";

import { signedFetch } from "./sigv4.js";

/**
 * The outcome of a Data API config lookup: the downstream HTTP status and raw
 * response body. A 200 body is expected to be the stored {@link CustomerConfig}
 * JSON.
 */
export interface ConfigLookupResult {
  /** Downstream HTTP status code from the Data API. */
  statusCode: number;
  /** Raw response body text (may be empty). */
  body: string;
}

/**
 * Loads a customer's config from the Data API. The production implementation
 * SigV4-signs `GET /customers/{customerId}/config` and delivers it with
 * `fetch`; tests override it via {@link setConfigLookupForTesting} so they never
 * sign or hit the network.
 */
export type ConfigLookup = (customerId: string) => Promise<ConfigLookupResult>;

/** Resolve the Data API base URL from the environment (set by AgentStack). */
function dataApiUrl(): string {
  const url = process.env.DATA_API_URL;
  if (!url) {
    // Misconfiguration — surfaces as a thrown error so the message retries.
    throw new Error("DATA_API_URL is not set");
  }
  return url;
}

/**
 * SigV4-sign `GET {DATA_API_URL}/customers/{customerId}/config` for the
 * `execute-api` service and deliver it with the shared {@link signedFetch}
 * helper. Credentials come from the Lambda execution role via the default
 * provider chain. The Data API returns the {@link CustomerConfig} as JSON
 * (Requirement 17.7).
 */
const defaultLookup: ConfigLookup = async (customerId) => {
  const baseUrl = dataApiUrl().replace(/\/+$/, "");
  const target = `${baseUrl}/customers/${encodeURIComponent(customerId)}/config`;

  return signedFetch({
    method: "GET",
    url: target,
    headers: { accept: "application/json" },
  });
};

/** Module-level lookup singleton (test seam). */
let lookup: ConfigLookup = defaultLookup;

/**
 * Override the Data API {@link ConfigLookup}. Test seam only — production code
 * never calls this. Pass `undefined` to reset back to the default SigV4
 * implementation.
 */
export function setConfigLookupForTesting(
  override: ConfigLookup | undefined,
): void {
  lookup = override ?? defaultLookup;
}

/**
 * Load a customer's {@link CustomerConfig} from the Data API
 * (Requirements 4.4, 4.5, 11.2).
 *
 * @returns the validated config, or `null` when the Data API reports the
 *   customer has no config (404) — a handled, non-retryable case (design Error
 *   Scenario 8).
 * @throws on a transient/upstream failure (non-2xx other than 404) or an
 *   unexpected 200 body that is not a valid {@link CustomerConfig}, so the
 *   caller lets the SQS message return to the queue and retry.
 */
export async function loadCustomerConfig(
  customerId: string,
): Promise<CustomerConfig | null> {
  const result = await lookup(customerId);

  if (result.statusCode === 404) {
    return null;
  }
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(
      `Data API config lookup for ${customerId} returned ${result.statusCode}`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(result.body) as unknown;
  } catch {
    throw new Error(
      `Data API config lookup for ${customerId} returned an unparseable body`,
    );
  }

  const parsed = customerConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `Data API config lookup for ${customerId} returned an invalid CustomerConfig`,
    );
  }
  return parsed.data;
}
