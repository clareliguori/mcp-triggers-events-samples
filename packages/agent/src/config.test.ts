/**
 * Unit tests for the Serverless Agent CustomerConfig loader (task 9.10).
 *
 * Two surfaces are covered:
 *
 * 1. {@link loadCustomerConfig}'s status/shape handling, driven through the
 *    {@link setConfigLookupForTesting} seam so no SigV4 signing or network call
 *    is made: a 200 valid body returns the parsed config, a 404 returns `null`
 *    (handled, non-retryable), a non-2xx/non-404 throws (SQS retry), and an
 *    unparseable / schema-invalid 200 body throws (Requirements 4.4, 4.5, 11.2,
 *    design Error Scenario 8).
 *
 * 2. The production `defaultLookup` URL. The Data API's webapp config route is
 *    Cognito-only; the agent must instead call the explicit IAM-authorized
 *    backend path `GET /backend/customers/{customerId}/config` (otherwise the
 *    SigV4 read is intercepted by the Cognito method and 401s). The shared
 *    {@link signedFetch} helper is mocked so the test asserts the exact signed
 *    URL without signing or hitting the network.
 */

import type { CustomerConfig } from "@mcp-events/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConfigLookupResult,
  loadCustomerConfig,
  setConfigLookupForTesting,
} from "./config.js";

// Mock the shared SigV4 helper so the production defaultLookup is exercised
// (URL construction, method, headers) without signing or network access.
const signedFetchMock = vi.fn();
vi.mock("./sigv4.js", () => ({
  signedFetch: (...args: unknown[]) => signedFetchMock(...args),
}));

const DATA_API_URL = "https://api.earthquake-agent.example.com";
const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";

/** A valid stored CustomerConfig body. */
function makeConfig(customerId = CUSTOMER_ID): CustomerConfig {
  return {
    customerId,
    displayName: "Acme Seismology",
    subscriptionParams: { minMagnitude: 4.5, region: "pacific" },
    briefingPrompt: "Summarize notable earthquakes for the Pacific region.",
    briefingSchedule: "0 */8 * * *",
    active: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  signedFetchMock.mockReset();
  process.env.DATA_API_URL = DATA_API_URL;
});

afterEach(() => {
  setConfigLookupForTesting(undefined);
  delete process.env.DATA_API_URL;
});

describe("loadCustomerConfig", () => {
  it("returns the parsed config on a 200 with a valid body", async () => {
    const config = makeConfig();
    setConfigLookupForTesting(
      async (): Promise<ConfigLookupResult> => ({
        statusCode: 200,
        body: JSON.stringify(config),
      }),
    );

    await expect(loadCustomerConfig(CUSTOMER_ID)).resolves.toEqual(config);
  });

  it("returns null on a 404 (handled, non-retryable)", async () => {
    setConfigLookupForTesting(
      async (): Promise<ConfigLookupResult> => ({
        statusCode: 404,
        body: JSON.stringify({ error: "Not Found" }),
      }),
    );

    await expect(loadCustomerConfig(CUSTOMER_ID)).resolves.toBeNull();
  });

  it("throws on a non-2xx that is not 404 (transient -> SQS retry)", async () => {
    setConfigLookupForTesting(
      async (): Promise<ConfigLookupResult> => ({
        statusCode: 503,
        body: "unavailable",
      }),
    );

    await expect(loadCustomerConfig(CUSTOMER_ID)).rejects.toThrow(/503/);
  });

  it("throws on a 200 body that is not valid JSON", async () => {
    setConfigLookupForTesting(
      async (): Promise<ConfigLookupResult> => ({
        statusCode: 200,
        body: "{not json",
      }),
    );

    await expect(loadCustomerConfig(CUSTOMER_ID)).rejects.toThrow(
      /unparseable/,
    );
  });

  it("throws on a 200 body that is not a valid CustomerConfig", async () => {
    setConfigLookupForTesting(
      async (): Promise<ConfigLookupResult> => ({
        statusCode: 200,
        body: JSON.stringify({ customerId: "not-a-uuid" }),
      }),
    );

    await expect(loadCustomerConfig(CUSTOMER_ID)).rejects.toThrow(
      /invalid CustomerConfig/,
    );
  });
});

describe("defaultLookup (production URL)", () => {
  it("signs GET against the IAM backend config path, not the Cognito webapp path", async () => {
    // Reset to the production lookup (afterEach in other suites may have run;
    // here we explicitly ensure the default is in place).
    setConfigLookupForTesting(undefined);

    const config = makeConfig();
    signedFetchMock.mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify(config),
    });

    await expect(loadCustomerConfig(CUSTOMER_ID)).resolves.toEqual(config);

    expect(signedFetchMock).toHaveBeenCalledTimes(1);
    const request = signedFetchMock.mock.calls[0][0] as {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    expect(request.method).toBe("GET");
    expect(request.url).toBe(
      `${DATA_API_URL}/backend/customers/${CUSTOMER_ID}/config`,
    );
    // Must NOT use the Cognito-only webapp path.
    expect(request.url).not.toContain(
      `${DATA_API_URL}/customers/${CUSTOMER_ID}/config`,
    );
    expect(request.headers).toMatchObject({ accept: "application/json" });
  });

  it("URL-encodes the customerId in the backend path", async () => {
    setConfigLookupForTesting(undefined);
    signedFetchMock.mockResolvedValue({ statusCode: 404, body: "" });

    await expect(loadCustomerConfig("a b/c")).resolves.toBeNull();

    const request = signedFetchMock.mock.calls[0][0] as { url: string };
    expect(request.url).toBe(
      `${DATA_API_URL}/backend/customers/a%20b%2Fc/config`,
    );
  });
});
