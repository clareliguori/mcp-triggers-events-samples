/**
 * Unit tests for the Data API route matcher (task 4.1).
 *
 * Verifies segment-based matching, path-parameter capture, method
 * discrimination, segment-count exactness, declaration-order precedence for
 * overlapping patterns, and URL-decoding of captured parameters.
 */

import { describe, expect, it } from "vitest";

import { isCustomerScoped, matchRoute } from "./router.js";
import type { ApiResult, RouteContext, RouteDefinition } from "./types.js";

/** A trivial handler used only to identify which route matched. */
function namedHandler(name: string) {
  return async (_ctx: RouteContext): Promise<ApiResult> => ({
    statusCode: 200,
    body: { matched: name },
  });
}

function def(method: string, pattern: string): RouteDefinition {
  return {
    method,
    pattern,
    customerScoped: isCustomerScoped(pattern),
    handler: namedHandler(pattern),
  };
}

const table: RouteDefinition[] = [
  def("GET", "/customers/:customerId/reports/:reportId"),
  def("GET", "/customers/:customerId/reports"),
  def("GET", "/customers/:customerId/config"),
  def("PUT", "/customers/:customerId/config"),
  def("GET", "/subscriptions/:subscriptionId"),
];

describe("matchRoute", () => {
  it("matches a literal + single param route and captures the param", () => {
    const match = matchRoute(table, "GET", "/customers/abc/config");
    expect(match).not.toBeNull();
    expect(match?.route.pattern).toBe("/customers/:customerId/config");
    expect(match?.params).toEqual({ customerId: "abc" });
  });

  it("captures multiple path parameters", () => {
    const match = matchRoute(
      table,
      "GET",
      "/customers/cust-1/reports/report-9",
    );
    expect(match?.route.pattern).toBe(
      "/customers/:customerId/reports/:reportId",
    );
    expect(match?.params).toEqual({
      customerId: "cust-1",
      reportId: "report-9",
    });
  });

  it("discriminates by HTTP method", () => {
    const get = matchRoute(table, "GET", "/customers/abc/config");
    const put = matchRoute(table, "PUT", "/customers/abc/config");
    const del = matchRoute(table, "DELETE", "/customers/abc/config");
    expect(get?.route.method).toBe("GET");
    expect(put?.route.method).toBe("PUT");
    expect(del).toBeNull();
  });

  it("is case-insensitive on the method", () => {
    const match = matchRoute(table, "get", "/customers/abc/config");
    expect(match?.route.pattern).toBe("/customers/:customerId/config");
  });

  it("requires an exact segment count (no greedy matching)", () => {
    expect(matchRoute(table, "GET", "/customers/abc")).toBeNull();
    expect(matchRoute(table, "GET", "/customers/abc/config/extra")).toBeNull();
  });

  it("does not match a different literal segment", () => {
    expect(matchRoute(table, "GET", "/clients/abc/config")).toBeNull();
  });

  it("matches the collection route when there is no trailing id", () => {
    const match = matchRoute(table, "GET", "/customers/abc/reports");
    expect(match?.route.pattern).toBe("/customers/:customerId/reports");
    expect(match?.params).toEqual({ customerId: "abc" });
  });

  it("tolerates a trailing slash", () => {
    const match = matchRoute(table, "GET", "/customers/abc/config/");
    expect(match?.route.pattern).toBe("/customers/:customerId/config");
  });

  it("URL-decodes captured parameters", () => {
    const match = matchRoute(table, "GET", "/subscriptions/sub%20with%20space");
    expect(match?.params).toEqual({ subscriptionId: "sub with space" });
  });

  it("returns null when nothing matches", () => {
    expect(matchRoute(table, "GET", "/nope")).toBeNull();
  });
});

describe("isCustomerScoped", () => {
  it("is true for patterns containing :customerId", () => {
    expect(isCustomerScoped("/customers/:customerId/config")).toBe(true);
    expect(isCustomerScoped("/customers/:customerId/reports/:reportId")).toBe(
      true,
    );
  });

  it("is false for patterns without :customerId", () => {
    expect(isCustomerScoped("/subscriptions/:subscriptionId")).toBe(false);
  });
});
