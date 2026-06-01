// Data API calls for CustomerConfig (task 12.3, Requirement 10.3).
//
// Kept separate from `customer-config.ts` so the pure types/validation there
// can be unit/property tested under plain Node without dragging in the API
// client's `$app/*` dependency (mirrors the auth module's `config-schema.ts`
// vs `config.ts` split). The Bearer JWT is attached by the shared API client.

import { apiRequest } from "$lib/api/client.js";
import type { CustomerConfig, CustomerConfigInput } from "./customer-config.js";

/** GET the stored config for a customer; `null` when none exists yet (404). */
export async function fetchCustomerConfig(
  customerId: string,
): Promise<CustomerConfig | null> {
  try {
    return await apiRequest<CustomerConfig>(
      "GET",
      `/customers/${customerId}/config`,
    );
  } catch (err) {
    if (isNotFound(err)) {
      return null;
    }
    throw err;
  }
}

/**
 * PUT a customer's config (Requirement 10.3). Sends the validated body with the
 * Bearer JWT (attached by the API client) and returns the stored config.
 */
export async function putCustomerConfig(
  customerId: string,
  input: CustomerConfigInput,
): Promise<CustomerConfig> {
  return apiRequest<CustomerConfig, CustomerConfigInput>(
    "PUT",
    `/customers/${customerId}/config`,
    { body: input },
  );
}

/** Narrow an unknown error to "the resource was not found" (HTTP 404). */
function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: unknown }).status === 404
  );
}
