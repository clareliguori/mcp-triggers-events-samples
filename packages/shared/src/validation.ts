/**
 * Zod validation schemas for the shared data models.
 *
 * These schemas back the Data API's request validation (Requirement 16) and
 * are also used by the MCP servers and the Subscription Manager when
 * accepting external input. Each schema mirrors the `interface` declared
 * in `models.ts`.
 */

import { z } from "zod";

import {
  BRIEFING_PROMPT_MAX_LENGTH,
  BRIEFING_PROMPT_MIN_LENGTH,
  CRON_REGEX,
  EVENT_NAME_BRIEFING_TRIGGER,
  EVENT_NAME_EARTHQUAKE_DETECTED,
  MAX_MAGNITUDE,
  MIN_MAGNITUDE,
  REGIONS,
  UUID_V4_REGEX,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

/** Strict UUID v4. Validates Requirement 16.1. */
export const uuidV4Schema = z
  .string()
  .regex(UUID_V4_REGEX, "must be a valid UUID v4");

/** ISO 8601 datetime string. */
export const isoDateTimeSchema = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), {
    message: "must be a valid ISO 8601 datetime",
  });

/** Cron expression (5 space-separated fields). Validates Requirement 16.5. */
export const cronExpressionSchema = z
  .string()
  .regex(CRON_REGEX, "must be a valid 5-field cron expression");

/** Region enum. Validates Requirement 16.3. */
export const regionSchema = z.enum(REGIONS);

// ---------------------------------------------------------------------------
// Customer configuration
// ---------------------------------------------------------------------------

/** Per-customer earthquake feed filter parameters. */
export const subscriptionParamsSchema = z.object({
  /** Validates Requirement 16.2. */
  minMagnitude: z.number().min(MIN_MAGNITUDE).max(MAX_MAGNITUDE).optional(),
  /** Validates Requirement 16.3. */
  region: regionSchema.optional(),
  maxDepthKm: z.number().positive().optional(),
});

/**
 * Input schema for `PUT /customers/:customerId/config`. Does not include
 * `customerId`, `active`, `createdAt`, or `updatedAt` — those are managed
 * by the Data API.
 *
 * Validates Requirements 16.2, 16.3, 16.4, 16.5.
 */
export const customerConfigInputSchema = z.object({
  displayName: z.string().min(1).max(200),
  subscriptionParams: subscriptionParamsSchema,
  /** Validates Requirement 16.4. */
  briefingPrompt: z
    .string()
    .min(BRIEFING_PROMPT_MIN_LENGTH)
    .max(BRIEFING_PROMPT_MAX_LENGTH),
  briefingSchedule: cronExpressionSchema,
});

/** Full CustomerConfig as stored in DynamoDB. */
export const customerConfigSchema = customerConfigInputSchema.extend({
  /** Validates Requirement 16.1. */
  customerId: uuidV4Schema,
  active: z.boolean(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

// ---------------------------------------------------------------------------
// MCP event payloads
// ---------------------------------------------------------------------------

export const earthquakeDetectedDataSchema = z.object({
  earthquakeId: z.string().min(1),
  magnitude: z.number(),
  place: z.string(),
  coordinates: z.object({
    longitude: z.number().min(-180).max(180),
    latitude: z.number().min(-90).max(90),
    depth: z.number().min(0),
  }),
  time: isoDateTimeSchema,
  tsunami: z.boolean(),
  felt: z.number().int().nonnegative().nullable(),
  alert: z.enum(["green", "yellow", "orange", "red"]).nullable(),
  url: z.string().url(),
});

export const briefingTriggerDataSchema = z.object({
  triggerType: z.enum(["scheduled", "manual"]),
  customerId: uuidV4Schema,
  reason: z.string().optional(),
  scheduledTime: isoDateTimeSchema,
});

export const earthquakeDetectedEventSchema = z.object({
  eventId: uuidV4Schema,
  name: z.literal(EVENT_NAME_EARTHQUAKE_DETECTED),
  timestamp: isoDateTimeSchema,
  data: earthquakeDetectedDataSchema,
  cursor: z.string(),
});

export const briefingTriggerEventSchema = z.object({
  eventId: uuidV4Schema,
  name: z.literal(EVENT_NAME_BRIEFING_TRIGGER),
  timestamp: isoDateTimeSchema,
  data: briefingTriggerDataSchema,
  cursor: z.string(),
});

/** Discriminated union of MCP event payloads. */
export const mcpEventPayloadSchema = z.discriminatedUnion("name", [
  earthquakeDetectedEventSchema,
  briefingTriggerEventSchema,
]);

// ---------------------------------------------------------------------------
// MCP `events/subscribe`
// ---------------------------------------------------------------------------

export const subscribeInputSchema = z.object({
  minMagnitude: z.number().min(MIN_MAGNITUDE).max(MAX_MAGNITUDE).optional(),
  region: regionSchema.optional(),
  maxDepthKm: z.number().positive().optional(),
  schedule: cronExpressionSchema.optional(),
});

export const subscribeParamsSchema = z.object({
  event: z.enum([EVENT_NAME_EARTHQUAKE_DETECTED, EVENT_NAME_BRIEFING_TRIGGER]),
  delivery: z.object({
    mode: z.literal("webhook"),
    url: z
      .string()
      .url()
      .refine((u) => u.startsWith("https://"), {
        message: "callback URL must use HTTPS",
      }),
    secret: z.string().min(32, "HMAC secret must be at least 32 characters"),
  }),
  inputSchema: subscribeInputSchema.optional(),
  ttl: z.number().int().positive().optional(),
});

export const subscribeResultSchema = z.object({
  subscriptionId: uuidV4Schema,
  expiresAt: isoDateTimeSchema,
});

// ---------------------------------------------------------------------------
// Persisted records (for completeness — used by internal handlers)
// ---------------------------------------------------------------------------

export const webhookSubscriptionSchema = z.object({
  subscriptionId: uuidV4Schema,
  customerId: uuidV4Schema,
  serverEndpoint: z.string().url(),
  eventName: z.enum([
    EVENT_NAME_EARTHQUAKE_DETECTED,
    EVENT_NAME_BRIEFING_TRIGGER,
  ]),
  callbackUrl: z.string().url(),
  hmacSecret: z.string().min(32),
  filterParams: subscriptionParamsSchema.optional(),
  schedule: cronExpressionSchema.optional(),
  createdAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  lastRefreshedAt: isoDateTimeSchema,
  status: z.enum(["active", "expired", "failed"]),
});

export const customerSessionLockSchema = z.object({
  lockKey: z.string().regex(/^lock#/, "lockKey must start with 'lock#'"),
  ownerId: z.string().min(1),
  acquiredAt: isoDateTimeSchema,
  expiresAt: z.number().int().positive(),
  ttlSeconds: z.number().int().positive(),
});

export const usgsCursorStateSchema = z.object({
  cursorId: z.string().min(1),
  lastSeenIds: z.array(z.string()),
  lastPollAt: isoDateTimeSchema,
  lastEmittedAt: isoDateTimeSchema,
  totalEmitted: z.number().int().nonnegative(),
});

export const notableQuakeSchema = z.object({
  earthquakeId: z.string().min(1),
  magnitude: z.number(),
  place: z.string(),
  reason: z.string(),
});

export const briefingReportSchema = z
  .object({
    reportId: uuidV4Schema,
    customerId: uuidV4Schema,
    customerDisplayName: z.string(),
    briefingPrompt: z
      .string()
      .min(BRIEFING_PROMPT_MIN_LENGTH)
      .max(BRIEFING_PROMPT_MAX_LENGTH),
    generatedAt: isoDateTimeSchema,
    periodStart: isoDateTimeSchema,
    periodEnd: isoDateTimeSchema,
    summary: z.string(),
    totalEarthquakes: z.number().int().nonnegative(),
    notableQuakes: z.array(notableQuakeSchema),
    geographicPatterns: z.string(),
    comparisonToPrevious: z.string(),
  })
  .refine((r) => Date.parse(r.periodStart) < Date.parse(r.periodEnd), {
    message: "periodStart must be before periodEnd",
    path: ["periodStart"],
  });

export const reportSummarySchema = z.object({
  reportId: uuidV4Schema,
  generatedAt: isoDateTimeSchema,
  periodStart: isoDateTimeSchema,
  periodEnd: isoDateTimeSchema,
  totalEarthquakes: z.number().int().nonnegative(),
  summary: z.string(),
});

// ---------------------------------------------------------------------------
// Inferred types — handy for handler code
// ---------------------------------------------------------------------------

export type CustomerConfigInput = z.infer<typeof customerConfigInputSchema>;
export type SubscribeParamsInput = z.infer<typeof subscribeParamsSchema>;
export type McpEventPayloadInput = z.infer<typeof mcpEventPayloadSchema>;
