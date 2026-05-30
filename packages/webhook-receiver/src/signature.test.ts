/**
 * Unit tests for the Standard Webhooks signature library (task 5.1).
 *
 * These exercise concrete examples and edge cases of the sign/verify round
 * trip, the per-subscription secret selection, the replay-protection timestamp
 * window, and the `X-MCP-Subscription-Id` header extraction. The exhaustive
 * round-trip and replay properties are covered separately by the property
 * tests in tasks 5.2 and 5.3.
 */

import { describe, expect, it } from "vitest";

import {
  MCP_SUBSCRIPTION_ID_HEADER,
  getSubscriptionId,
  isTimestampWithinTolerance,
  signWebhook,
  verifyWebhook,
} from "./signature.js";

/** A structurally valid `whsec_` secret (prefix + base64 of 32 bytes). */
const SECRET_A = `whsec_${Buffer.alloc(32, 1).toString("base64")}`;
const SECRET_B = `whsec_${Buffer.alloc(32, 2).toString("base64")}`;

const PAYLOAD = JSON.stringify({
  eventId: "11111111-1111-4111-8111-111111111111",
  name: "earthquake.detected",
  timestamp: "2024-01-01T00:00:00.000Z",
  data: { earthquakeId: "us7000n123", magnitude: 5.2 },
  cursor: "abc",
});

describe("signWebhook / verifyWebhook round trip", () => {
  it("verifies a freshly signed payload against the same secret", () => {
    const headers = signWebhook(PAYLOAD, SECRET_A);
    const result = verifyWebhook(PAYLOAD, headers, SECRET_A);
    expect(result).toEqual({ valid: true });
  });

  it("emits the three Standard Webhooks headers", () => {
    const headers = signWebhook(PAYLOAD, SECRET_A);
    expect(headers["webhook-id"]).toMatch(/^msg_/);
    expect(headers["webhook-timestamp"]).toMatch(/^\d+$/);
    expect(headers["webhook-signature"]).toMatch(/^v1,/);
  });

  it("honors an explicit msgId and timestamp override", () => {
    const ts = new Date("2024-06-01T12:00:00.000Z");
    const headers = signWebhook(PAYLOAD, SECRET_A, {
      msgId: "msg_fixed",
      timestamp: ts,
    });
    expect(headers["webhook-id"]).toBe("msg_fixed");
    expect(headers["webhook-timestamp"]).toBe(
      String(Math.floor(ts.getTime() / 1000)),
    );
  });

  it("rejects verification under a different per-subscription secret", () => {
    const headers = signWebhook(PAYLOAD, SECRET_A);
    const result = verifyWebhook(PAYLOAD, headers, SECRET_B);
    expect(result).toEqual({ valid: false, reason: "invalid_signature" });
  });

  it("rejects a tampered payload", () => {
    const headers = signWebhook(PAYLOAD, SECRET_A);
    const result = verifyWebhook(`${PAYLOAD} `, headers, SECRET_A);
    expect(result).toEqual({ valid: false, reason: "invalid_signature" });
  });

  it("verifies a Buffer payload signed as a Buffer", () => {
    const buf = Buffer.from(PAYLOAD, "utf8");
    const headers = signWebhook(buf, SECRET_A);
    const result = verifyWebhook(buf, headers, SECRET_A);
    expect(result).toEqual({ valid: true });
  });

  it("accepts headers regardless of casing", () => {
    const headers = signWebhook(PAYLOAD, SECRET_A);
    const upperCased = {
      "Webhook-Id": headers["webhook-id"],
      "Webhook-Timestamp": headers["webhook-timestamp"],
      "Webhook-Signature": headers["webhook-signature"],
    };
    expect(verifyWebhook(PAYLOAD, upperCased, SECRET_A)).toEqual({
      valid: true,
    });
  });
});

describe("verifyWebhook failure modes", () => {
  it("reports missing_headers when any signature header is absent", () => {
    const headers = signWebhook(PAYLOAD, SECRET_A);
    const { "webhook-signature": _omit, ...rest } = headers;
    expect(verifyWebhook(PAYLOAD, rest, SECRET_A)).toEqual({
      valid: false,
      reason: "missing_headers",
    });
  });

  it("reports invalid_timestamp for a non-numeric timestamp", () => {
    const headers = signWebhook(PAYLOAD, SECRET_A);
    const result = verifyWebhook(
      PAYLOAD,
      { ...headers, "webhook-timestamp": "not-a-number" },
      SECRET_A,
    );
    expect(result).toEqual({ valid: false, reason: "invalid_timestamp" });
  });

  it("reports timestamp_out_of_tolerance for an old delivery, regardless of signature", () => {
    const old = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    const headers = signWebhook(PAYLOAD, SECRET_A, { timestamp: old });
    const result = verifyWebhook(PAYLOAD, headers, SECRET_A);
    expect(result).toEqual({
      valid: false,
      reason: "timestamp_out_of_tolerance",
    });
  });

  it("reports invalid_secret for an empty secret", () => {
    const headers = signWebhook(PAYLOAD, SECRET_A);
    expect(verifyWebhook(PAYLOAD, headers, "")).toEqual({
      valid: false,
      reason: "invalid_secret",
    });
  });
});

describe("isTimestampWithinTolerance", () => {
  const now = 1_700_000_000;

  it("accepts the current time", () => {
    expect(isTimestampWithinTolerance(now, { nowSeconds: now })).toBe(true);
  });

  it("accepts the inclusive boundaries (+/- tolerance)", () => {
    expect(
      isTimestampWithinTolerance(now - 300, {
        nowSeconds: now,
        toleranceSeconds: 300,
      }),
    ).toBe(true);
    expect(
      isTimestampWithinTolerance(now + 300, {
        nowSeconds: now,
        toleranceSeconds: 300,
      }),
    ).toBe(true);
  });

  it("rejects timestamps older than the tolerance window", () => {
    expect(
      isTimestampWithinTolerance(now - 301, {
        nowSeconds: now,
        toleranceSeconds: 300,
      }),
    ).toBe(false);
  });

  it("rejects timestamps further in the future than the tolerance window", () => {
    expect(
      isTimestampWithinTolerance(now + 301, {
        nowSeconds: now,
        toleranceSeconds: 300,
      }),
    ).toBe(false);
  });

  it("rejects non-finite values", () => {
    expect(isTimestampWithinTolerance(Number.NaN)).toBe(false);
    expect(isTimestampWithinTolerance(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("getSubscriptionId", () => {
  const subId = "22222222-2222-4222-8222-222222222222";

  it("extracts the X-MCP-Subscription-Id header (exact casing)", () => {
    expect(getSubscriptionId({ [MCP_SUBSCRIPTION_ID_HEADER]: subId })).toBe(
      subId,
    );
  });

  it("extracts the header case-insensitively", () => {
    expect(getSubscriptionId({ "x-mcp-subscription-id": subId })).toBe(subId);
  });

  it("returns undefined when the header is missing", () => {
    expect(getSubscriptionId({})).toBeUndefined();
  });

  it("returns undefined when the header is empty", () => {
    expect(
      getSubscriptionId({ [MCP_SUBSCRIPTION_ID_HEADER]: "" }),
    ).toBeUndefined();
  });
});
