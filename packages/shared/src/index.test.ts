/**
 * Smoke test verifying that the public surface of @mcp-events/shared is
 * importable and the schemas behave as expected.
 *
 * Property-based testing of input validation lives in task 1.3
 * (Property 12: Input Validation Correctness). This file just confirms
 * the types and schemas are reachable and basic happy/sad paths work.
 */

import { describe, expect, it } from "vitest";

import {
  BRIEFING_PROMPT_MAX_LENGTH,
  CRON_REGEX,
  EVENT_NAME_BRIEFING_TRIGGER,
  EVENT_NAME_EARTHQUAKE_DETECTED,
  MAX_MAGNITUDE,
  MIN_MAGNITUDE,
  REGIONS,
  UUID_V4_REGEX,
  customerConfigInputSchema,
  customerConfigSchema,
  cronExpressionSchema,
  earthquakeDetectedEventSchema,
  mcpEventPayloadSchema,
  subscribeParamsSchema,
  uuidV4Schema,
  type AgentSessionState,
  type BriefingReport,
  type BriefingTriggerData,
  type CustomerConfig,
  type CustomerSessionLock,
  type EarthquakeDetectedData,
  type McpEventPayload,
  type NotableQuake,
  type Region,
  type ReportSummary,
  type SubscribeParams,
  type SubscribeResult,
  type UsgsCursorState,
  type WebhookSubscription,
} from "./index.js";

const validUuid = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";

describe("@mcp-events/shared exports", () => {
  it("exports all data model types (compile-time check)", () => {
    // Construct a typed value of each model so the compiler verifies the
    // types are exported and assignable.
    const customer: CustomerConfig = {
      customerId: validUuid,
      displayName: "Test Customer",
      subscriptionParams: { minMagnitude: 4, region: "pacific" },
      briefingPrompt: "Summarize recent seismic activity",
      briefingSchedule: "0 */6 * * *",
      active: true,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };
    expect(customer.customerId).toBe(validUuid);

    const earthquakeData: EarthquakeDetectedData = {
      earthquakeId: "us7000n123",
      magnitude: 5.4,
      place: "10km SW of Ridgecrest, CA",
      coordinates: { longitude: -117.6, latitude: 35.6, depth: 8 },
      time: "2024-01-01T00:00:00Z",
      tsunami: false,
      felt: null,
      alert: null,
      url: "https://example.com/eq",
    };
    const earthquakeEvent: McpEventPayload = {
      eventId: validUuid,
      name: EVENT_NAME_EARTHQUAKE_DETECTED,
      timestamp: "2024-01-01T00:00:00Z",
      data: earthquakeData,
      cursor: "abc",
    };
    expect(earthquakeEvent.name).toBe("earthquake.detected");

    const triggerData: BriefingTriggerData = {
      triggerType: "scheduled",
      customerId: validUuid,
      scheduledTime: "2024-01-01T00:00:00Z",
    };
    expect(triggerData.triggerType).toBe("scheduled");

    // Touch the remaining types so the import isn't tree-shaken away.
    const lock: CustomerSessionLock = {
      lockKey: `lock#${validUuid}`,
      ownerId: "req-123",
      acquiredAt: "2024-01-01T00:00:00Z",
      expiresAt: 1_700_000_000,
      ttlSeconds: 60,
    };
    const subscription: WebhookSubscription = {
      subscriptionId: validUuid,
      customerId: validUuid,
      serverEndpoint: "https://server.example.com/mcp",
      eventName: EVENT_NAME_BRIEFING_TRIGGER,
      callbackUrl: "https://webhook.example.com/wh",
      secret: `whsec_${"A".repeat(43)}=`,
      schedule: "0 0 * * *",
      createdAt: "2024-01-01T00:00:00Z",
      expiresAt: "2024-01-01T01:00:00Z",
      lastRefreshedAt: "2024-01-01T00:00:00Z",
      status: "active",
    };
    const session: AgentSessionState = {
      sessionId: validUuid,
      customerId: validUuid,
      messages: [],
      metadata: {
        lastEventId: validUuid,
        lastActiveAt: "2024-01-01T00:00:00Z",
        invocationCount: 0,
        lastBriefingAt: null,
        customerDisplayName: "Test",
      },
    };
    const notable: NotableQuake = {
      earthquakeId: "us7000n123",
      magnitude: 6.0,
      place: "Somewhere",
      reason: "largest of the period",
    };
    const report: BriefingReport = {
      reportId: validUuid,
      customerId: validUuid,
      customerDisplayName: "Test",
      briefingPrompt: "x",
      generatedAt: "2024-01-02T00:00:00Z",
      periodStart: "2024-01-01T00:00:00Z",
      periodEnd: "2024-01-02T00:00:00Z",
      summary: "summary",
      totalEarthquakes: 1,
      notableQuakes: [notable],
      geographicPatterns: "p",
      comparisonToPrevious: "c",
    };
    const summary: ReportSummary = {
      reportId: report.reportId,
      generatedAt: report.generatedAt,
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      totalEarthquakes: report.totalEarthquakes,
      summary: report.summary,
    };
    const subscribeParams: SubscribeParams = {
      event: "earthquake.detected",
      delivery: {
        mode: "webhook",
        url: "https://webhook.example.com/wh",
        secret: "x".repeat(32),
      },
      inputSchema: { minMagnitude: 4 },
    };
    const subscribeResult: SubscribeResult = {
      subscriptionId: validUuid,
      expiresAt: "2024-01-01T01:00:00Z",
    };
    const cursor: UsgsCursorState = {
      cursorId: "usgs-2.5-day",
      lastSeenIds: ["us7000n123"],
      lastPollAt: "2024-01-01T00:00:00Z",
      lastEmittedAt: "2024-01-01T00:00:00Z",
      totalEmitted: 1,
    };
    const region: Region = "pacific";

    expect([
      lock,
      subscription,
      session,
      summary,
      subscribeParams,
      subscribeResult,
      cursor,
      region,
    ]).toHaveLength(8);
  });

  it("constants expose expected domain values", () => {
    expect(REGIONS).toContain("pacific");
    expect(REGIONS).toContain("africa");
    expect(MIN_MAGNITUDE).toBe(0);
    expect(MAX_MAGNITUDE).toBe(10);
    expect(BRIEFING_PROMPT_MAX_LENGTH).toBe(2000);
    expect(UUID_V4_REGEX.test(validUuid)).toBe(true);
    expect(CRON_REGEX.test("0 0 * * *")).toBe(true);
    expect(CRON_REGEX.test("not a cron")).toBe(false);
  });

  it("uuidV4Schema accepts valid UUIDs and rejects invalid ones", () => {
    expect(uuidV4Schema.safeParse(validUuid).success).toBe(true);
    expect(uuidV4Schema.safeParse("not-a-uuid").success).toBe(false);
    // v1 UUID should fail (third group must start with 4)
    expect(
      uuidV4Schema.safeParse("a1b2c3d4-e5f6-1890-abcd-ef1234567890").success,
    ).toBe(false);
  });

  it("cronExpressionSchema validates 5-field cron expressions", () => {
    expect(cronExpressionSchema.safeParse("0 */6 * * *").success).toBe(true);
    expect(cronExpressionSchema.safeParse("0,15,30,45 * * * *").success).toBe(
      true,
    );
    expect(cronExpressionSchema.safeParse("garbage").success).toBe(false);
    expect(cronExpressionSchema.safeParse("0 0 * *").success).toBe(false);
  });

  it("customerConfigInputSchema accepts valid configs", () => {
    const result = customerConfigInputSchema.safeParse({
      displayName: "Test",
      subscriptionParams: { minMagnitude: 5, region: "pacific" },
      briefingPrompt: "Briefing me on earthquakes",
      briefingSchedule: "0 0 * * *",
    });
    expect(result.success).toBe(true);
  });

  it("customerConfigInputSchema rejects out-of-range magnitudes", () => {
    const result = customerConfigInputSchema.safeParse({
      displayName: "Test",
      subscriptionParams: { minMagnitude: 11 },
      briefingPrompt: "Brief me",
      briefingSchedule: "0 0 * * *",
    });
    expect(result.success).toBe(false);
  });

  it("customerConfigInputSchema rejects unknown regions", () => {
    const result = customerConfigInputSchema.safeParse({
      displayName: "Test",
      subscriptionParams: { region: "antarctica" },
      briefingPrompt: "Brief me",
      briefingSchedule: "0 0 * * *",
    });
    expect(result.success).toBe(false);
  });

  it("customerConfigInputSchema rejects empty and overly long prompts", () => {
    expect(
      customerConfigInputSchema.safeParse({
        displayName: "Test",
        subscriptionParams: {},
        briefingPrompt: "",
        briefingSchedule: "0 0 * * *",
      }).success,
    ).toBe(false);

    expect(
      customerConfigInputSchema.safeParse({
        displayName: "Test",
        subscriptionParams: {},
        briefingPrompt: "x".repeat(BRIEFING_PROMPT_MAX_LENGTH + 1),
        briefingSchedule: "0 0 * * *",
      }).success,
    ).toBe(false);
  });

  it("customerConfigSchema requires UUID v4 customerId", () => {
    expect(
      customerConfigSchema.safeParse({
        customerId: "not-a-uuid",
        displayName: "Test",
        subscriptionParams: {},
        briefingPrompt: "x",
        briefingSchedule: "0 0 * * *",
        active: true,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("mcpEventPayloadSchema discriminates earthquake vs briefing events", () => {
    const earthquake = mcpEventPayloadSchema.safeParse({
      eventId: validUuid,
      name: "earthquake.detected",
      timestamp: "2024-01-01T00:00:00Z",
      cursor: "c",
      data: {
        earthquakeId: "us123",
        magnitude: 4.5,
        place: "x",
        coordinates: { longitude: 0, latitude: 0, depth: 0 },
        time: "2024-01-01T00:00:00Z",
        tsunami: false,
        felt: null,
        alert: null,
        url: "https://example.com/q",
      },
    });
    expect(earthquake.success).toBe(true);
  });

  it("earthquakeDetectedEventSchema rejects out-of-range coordinates", () => {
    const result = earthquakeDetectedEventSchema.safeParse({
      eventId: validUuid,
      name: "earthquake.detected",
      timestamp: "2024-01-01T00:00:00Z",
      cursor: "c",
      data: {
        earthquakeId: "us123",
        magnitude: 4.5,
        place: "x",
        coordinates: { longitude: 200, latitude: 0, depth: 0 },
        time: "2024-01-01T00:00:00Z",
        tsunami: false,
        felt: null,
        alert: null,
        url: "https://example.com/q",
      },
    });
    expect(result.success).toBe(false);
  });

  it("subscribeParamsSchema requires HTTPS callback URL and a valid whsec_ secret", () => {
    const validSecret = `whsec_${"A".repeat(43)}=`; // decodes to 32 bytes

    // Rejects non-HTTPS callback URL.
    expect(
      subscribeParamsSchema.safeParse({
        event: "earthquake.detected",
        delivery: {
          mode: "webhook",
          url: "http://insecure.example.com/wh",
          secret: validSecret,
        },
      }).success,
    ).toBe(false);

    // Rejects a secret without the whsec_ prefix.
    expect(
      subscribeParamsSchema.safeParse({
        event: "earthquake.detected",
        delivery: {
          mode: "webhook",
          url: "https://example.com/wh",
          secret: "x".repeat(32),
        },
      }).success,
    ).toBe(false);

    // Rejects a whsec_ secret that decodes to fewer than 24 bytes.
    expect(
      subscribeParamsSchema.safeParse({
        event: "earthquake.detected",
        delivery: {
          mode: "webhook",
          url: "https://example.com/wh",
          secret: "whsec_c2hvcnQ=", // "short" -> 5 bytes
        },
      }).success,
    ).toBe(false);

    // Accepts a valid HTTPS URL and a valid whsec_ secret.
    expect(
      subscribeParamsSchema.safeParse({
        event: "earthquake.detected",
        delivery: {
          mode: "webhook",
          url: "https://example.com/wh",
          secret: validSecret,
        },
      }).success,
    ).toBe(true);
  });
});
