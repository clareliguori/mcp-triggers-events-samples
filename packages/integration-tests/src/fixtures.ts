/**
 * Test data builders for the end-to-end integration suite (task 13.2).
 *
 * The flows need valid customer configs, MCP event payloads, and subscription
 * records that satisfy the same shared zod schemas the deployed services
 * enforce. Centralizing the builders here keeps each flow focused on the
 * assertion (registration, accumulation, isolation, ...) rather than on
 * assembling well-formed fixtures, and guarantees every generated id is a fresh
 * UUID v4 so concurrent / repeated runs never collide on customer or event ids.
 */

import { randomUUID } from "node:crypto";

import type {
  CustomerConfig,
  EarthquakeDetectedData,
  McpEventPayload,
} from "@mcp-events/shared";
import {
  DEFAULT_SUBSCRIPTION_TTL_SECONDS,
  generateWebhookSecret,
} from "@mcp-events/shared";

/** A unique customer id (Cognito sub shape: UUID v4). */
export function newCustomerId(): string {
  return randomUUID();
}

/** A unique subscription id (UUID v4). */
export function newSubscriptionId(): string {
  return randomUUID();
}

/** A fresh per-subscription Standard Webhooks `whsec_` secret. */
export function newWebhookSecret(): string {
  return generateWebhookSecret();
}

/** Input shape accepted by `PUT /customers/:customerId/config`. */
export type CustomerConfigInputFields = Pick<
  CustomerConfig,
  "displayName" | "subscriptionParams" | "briefingPrompt" | "briefingSchedule"
>;

/**
 * Build a valid CustomerConfig input. Defaults to a permissive filter (a low
 * minimum magnitude, no region/depth limit) and a daily briefing so the
 * accumulation / briefing flows reliably match a simulated earthquake.
 */
export function customerConfigInput(
  overrides: Partial<CustomerConfigInputFields> = {},
): CustomerConfigInputFields {
  return {
    displayName: overrides.displayName ?? "Integration Test Customer",
    subscriptionParams: overrides.subscriptionParams ?? { minMagnitude: 1.0 },
    briefingPrompt:
      overrides.briefingPrompt ??
      "You are an earthquake monitoring assistant. Summarize recent seismic activity.",
    briefingSchedule: overrides.briefingSchedule ?? 24,
  };
}

/**
 * Build a valid `earthquake.detected` event payload. The earthquake defaults to
 * a clearly-notable magnitude-6.2 quake so a permissive customer filter always
 * matches it; pass `data` overrides to tune magnitude / region / depth.
 */
export function earthquakeEvent(
  overrides: { data?: Partial<EarthquakeDetectedData>; eventId?: string } = {},
): McpEventPayload {
  const earthquakeId =
    overrides.data?.earthquakeId ?? `it${randomUUID().replace(/-/g, "")}`;
  const data: EarthquakeDetectedData = {
    earthquakeId,
    magnitude: overrides.data?.magnitude ?? 6.2,
    place: overrides.data?.place ?? "120km SSW of Integration Test Island",
    coordinates: overrides.data?.coordinates ?? {
      longitude: -119.5,
      latitude: 35.5,
      depth: 10.0,
    },
    time: overrides.data?.time ?? new Date().toISOString(),
    tsunami: overrides.data?.tsunami ?? false,
    felt: overrides.data?.felt ?? null,
    alert: overrides.data?.alert ?? "yellow",
    url:
      overrides.data?.url ??
      `https://earthquake.usgs.gov/earthquakes/eventpage/${earthquakeId}`,
  };
  return {
    eventId: overrides.eventId ?? randomUUID(),
    name: "earthquake.detected",
    timestamp: new Date().toISOString(),
    data,
    cursor: new Date().toISOString(),
  };
}

/** Build a valid `briefing.trigger` event payload for a customer. */
export function briefingTriggerEvent(
  customerId: string,
  overrides: { eventId?: string; triggerType?: "scheduled" | "manual" } = {},
): McpEventPayload {
  return {
    eventId: overrides.eventId ?? randomUUID(),
    name: "briefing.trigger",
    timestamp: new Date().toISOString(),
    data: {
      triggerType: overrides.triggerType ?? "manual",
      customerId,
      reason: "integration-test",
      scheduledTime: new Date().toISOString(),
    },
    cursor: new Date().toISOString(),
  };
}

/**
 * Build a subscription record body for `POST /customers/:id/subscriptions`.
 * Carries the plaintext `secret` (the Data API encrypts it at rest) and an
 * `expiresAt` derived from the supplied TTL so refresh flows can assert it
 * moves forward.
 */
export function subscriptionRecord(args: {
  subscriptionId: string;
  customerId: string;
  secret: string;
  serverEndpoint: string;
  callbackUrl: string;
  eventName?: "earthquake.detected" | "briefing.trigger";
  ttlSeconds?: number;
}): Record<string, unknown> {
  const now = new Date();
  const ttl = args.ttlSeconds ?? DEFAULT_SUBSCRIPTION_TTL_SECONDS;
  const expiresAt = new Date(now.getTime() + ttl * 1000);
  return {
    subscriptionId: args.subscriptionId,
    customerId: args.customerId,
    serverEndpoint: args.serverEndpoint,
    eventName: args.eventName ?? "earthquake.detected",
    callbackUrl: args.callbackUrl,
    secret: args.secret,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    lastRefreshedAt: now.toISOString(),
    status: "active",
  };
}
