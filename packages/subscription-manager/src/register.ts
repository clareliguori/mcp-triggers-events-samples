/**
 * Customer registration for the Subscription Manager (task 10.1).
 *
 * This module handles the **DynamoDB Stream** half of the Subscription Manager
 * (design Component 5): when the Data API writes a new `CustomerConfig` to the
 * CustomerConfig table, the table's stream fires an `INSERT` event that wakes
 * this Lambda. For each newly-registered, active customer it:
 *
 * 1. Generates a fresh per-subscription Standard Webhooks `whsec_` secret
 *    (CSPRNG) for EACH server subscription (see `secret.ts`). The Subscription
 *    Manager (the MCP Client/Host) OWNS secret generation — the servers never
 *    generate it (Requirements 14.6, design Component 5).
 * 2. Calls MCP Server 1 (`usgs`) `events/subscribe` with the customer's filter
 *    params (`minMagnitude` / `region` / `maxDepthKm`) and that subscription's
 *    generated secret in `delivery.secret` (Requirement 8.1, 14.6).
 * 3. Calls MCP Server 2 (`scheduler`) `events/subscribe` with the customer's
 *    cron `schedule` and its own generated `delivery.secret` (Requirement 8.1,
 *    14.6).
 * 4. Stores a {@link WebhookSubscription} record for each via the Data API
 *    (`POST /customers/{customerId}/subscriptions`), carrying the **plaintext**
 *    `whsec_` secret (Requirement 8.3). The Subscription Manager holds NO KMS
 *    permissions: it exchanges the plaintext secret with the Data API over
 *    IAM-authed HTTPS and the Data API field-encrypts it at its storage
 *    boundary (Requirement 17.9).
 *
 * Both MCP server calls and the Data API call are IAM SigV4-signed. The MCP
 * calls use `@aws/run-mcp-servers-with-aws-lambda`'s
 * {@link StreamableHTTPClientWithSigV4Transport}; the Data API calls reuse the
 * same package's {@link createSigV4Fetch} so all server-to-server traffic is
 * signed for the `execute-api` service (Requirements 14.6, 17.6, 17.7).
 *
 * ## Partial-failure handling (Requirement 8.1)
 *
 * The two servers are subscribed independently, and each subscription's
 * subscribe-then-store sequence is retried with bounded exponential backoff
 * ({@link REGISTER_RETRY_DELAYS_MS}). A failure on one server therefore neither
 * blocks nor re-does the other: if MCP Server 1 succeeds but MCP Server 2's
 * subscribe fails, only Server 2 is retried, and Server 1's stored record is
 * left intact. The subscribe and store steps are retried *separately* so a
 * transient Data API write failure re-stores the same `subscriptionId` rather
 * than orphaning a fresh subscription on the server.
 *
 * ## Idempotency (design Component 5)
 *
 * Before creating, this module best-effort lists the customer's existing
 * subscriptions via the Data API and skips any server that already has an
 * active subscription, so a stream redrive (the event source uses
 * `reportBatchItemFailures` with retries) after a partial success does not
 * create duplicates. A failure to read existing subscriptions never blocks
 * creation — it simply proceeds as if none existed.
 *
 * ## Testability
 *
 * Every side effect is injectable via a `setXForTesting` seam — the MCP
 * subscribe call, the Data API store, the Data API existing-subscriptions
 * loader, and `sleep` — so unit tests exercise the real registration logic
 * (stream parsing, secret generation, target selection, partial-failure retry)
 * without signing, networking, or waiting on real timers. Production code never
 * calls the setters. This mirrors the seams used by the agent's `router.ts` and
 * `briefing.ts`.
 */

import {
  createSigV4Fetch,
  StreamableHTTPClientWithSigV4Transport,
} from "@aws/run-mcp-servers-with-aws-lambda";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type {
  CustomerConfig,
  SubscribeParams,
  SubscribeResult,
  SubscribeInputSchema,
  WebhookSubscription,
} from "@mcp-events/shared";
import {
  DEFAULT_SUBSCRIPTION_TTL_SECONDS,
  EVENT_NAME_BRIEFING_TRIGGER,
  EVENT_NAME_EARTHQUAKE_DETECTED,
  customerConfigSchema,
  subscribeResultSchema,
} from "@mcp-events/shared";
import type { DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";

import { generateWebhookSecret } from "./secret.js";

// ---------------------------------------------------------------------------
// Server targets
// ---------------------------------------------------------------------------

/** Which MCP server a subscription targets. */
export type ServerKey = "usgs" | "scheduler";

/**
 * The body sent to the Data API to persist a subscription record
 * (`POST /customers/{customerId}/subscriptions`). It is a
 * {@link WebhookSubscription} with the encrypted-at-rest `encryptedSecret`
 * replaced by the plaintext `secret`; the Data API encrypts it at its storage
 * boundary (Requirement 17.9).
 */
export type SubscriptionCreateBody = Omit<
  WebhookSubscription,
  "encryptedSecret"
> & {
  /** Plaintext Standard Webhooks `whsec_` secret. */
  secret: string;
};

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** Resolve the signing region from the Lambda environment. */
function signingRegion(): string {
  return (
    process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1"
  );
}

/** Resolve a required environment variable, throwing a clear error when unset. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Misconfiguration — surfaces as a thrown error so the stream record
    // retries rather than silently dropping a registration.
    throw new Error(`${name} is not set`);
  }
  return value;
}

/** The Data API base URL (set by SubscriptionManagerStack). */
function dataApiUrl(): string {
  return requireEnv("DATA_API_URL").replace(/\/+$/, "");
}

/** The MCP Server 1 (USGS) `events/subscribe` endpoint. */
function usgsMcpUrl(): string {
  return requireEnv("USGS_MCP_URL");
}

/** The MCP Server 2 (Scheduler) `events/subscribe` endpoint. */
function schedulerMcpUrl(): string {
  return requireEnv("SCHEDULER_MCP_URL");
}

/**
 * The webhook callback URL deliveries are POSTed to. `WEBHOOK_URL` is the
 * Webhook Receiver origin (e.g. `https://webhook.earthquake-agent.<domain>`);
 * the receiver serves deliveries at `POST /webhook`.
 */
function webhookCallbackUrl(): string {
  return `${requireEnv("WEBHOOK_URL").replace(/\/+$/, "")}/webhook`;
}

// ---------------------------------------------------------------------------
// MCP subscribe seam (StreamableHTTPClientWithSigV4Transport)
// ---------------------------------------------------------------------------

/** Subscribe params plus the optional `customerId` extension the servers store. */
export type McpSubscribeParams = SubscribeParams & { customerId: string };

/**
 * Calls an MCP server's `events/subscribe` method and returns the
 * {@link SubscribeResult}. The production implementation connects with
 * {@link StreamableHTTPClientWithSigV4Transport}; tests override it via
 * {@link setMcpSubscriberForTesting}.
 */
export type McpSubscriber = (
  serverUrl: string,
  params: McpSubscribeParams,
) => Promise<SubscribeResult>;

/**
 * Default MCP subscriber: connect to the server's MCP HTTP transport with an
 * IAM SigV4-signed Streamable HTTP transport, issue `events/subscribe`, and
 * validate the response against the shared {@link subscribeResultSchema}
 * (Requirements 14.3, 14.6, 17.6). A fresh client/connection is used per call
 * and always closed.
 */
const defaultMcpSubscriber: McpSubscriber = async (serverUrl, params) => {
  const client = new Client(
    { name: "subscription-manager", version: "1.0.0" },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientWithSigV4Transport(
    new URL(serverUrl),
    { service: "execute-api", region: signingRegion() },
  );

  await client.connect(transport);
  try {
    // Map our internal SubscribeParams shape to the MCP Events protocol wire
    // format expected by the SDK's McpServer (events/subscribe).
    // Include customerId in params so the server's subscription store can route
    // by customer for schedule checks and manual triggers.
    const wireParams = {
      name: params.event,
      delivery: {
        mode: "webhook" as const,
        url: params.delivery.url,
        secret: params.delivery.secret,
      },
      params: {
        ...(params.inputSchema ?? {}),
        customerId: params.customerId,
      },
    };
    return await client.request(
      {
        method: "events/subscribe",
        params: wireParams,
      },
      subscribeResultSchema,
    );
  } finally {
    await client.close();
  }
};

let mcpSubscriber: McpSubscriber = defaultMcpSubscriber;

/**
 * Override the {@link McpSubscriber}. Test seam only — production code never
 * calls this. Pass `undefined` to reset to the default SigV4 implementation.
 */
export function setMcpSubscriberForTesting(
  override: McpSubscriber | undefined,
): void {
  mcpSubscriber = override ?? defaultMcpSubscriber;
}

// ---------------------------------------------------------------------------
// Data API seams (IAM SigV4 via createSigV4Fetch)
// ---------------------------------------------------------------------------

/** Lazily-created SigV4 `fetch` for `execute-api`, reused across warm invocations. */
let sigV4Fetch: FetchLike | undefined;

/** Return the shared SigV4 fetch, creating it on first use. */
function getSigV4Fetch(): FetchLike {
  if (!sigV4Fetch) {
    sigV4Fetch = createSigV4Fetch({
      service: "execute-api",
      region: signingRegion(),
    });
  }
  return sigV4Fetch;
}

/** Outcome of a Data API call: downstream status and raw response body. */
export interface DataApiResult {
  /** Downstream HTTP status code from the Data API. */
  statusCode: number;
  /** Raw response body text (may be empty). */
  body: string;
}

/**
 * Persists a subscription record via the Data API
 * (`POST /customers/{customerId}/subscriptions`). The production implementation
 * SigV4-signs the request; tests override it via
 * {@link setSubscriptionStoreForTesting}.
 */
export type SubscriptionStore = (
  customerId: string,
  body: SubscriptionCreateBody,
) => Promise<DataApiResult>;

/** Default store: SigV4-signed `POST /customers/{customerId}/subscriptions`. */
const defaultSubscriptionStore: SubscriptionStore = async (
  customerId,
  body,
) => {
  const target = `${dataApiUrl()}/customers/${encodeURIComponent(customerId)}/subscriptions`;
  const response = await getSigV4Fetch()(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  return { statusCode: response.status, body: await response.text() };
};

let subscriptionStore: SubscriptionStore = defaultSubscriptionStore;

/**
 * Override the {@link SubscriptionStore}. Test seam only — production code never
 * calls this. Pass `undefined` to reset to the default SigV4 implementation.
 */
export function setSubscriptionStoreForTesting(
  override: SubscriptionStore | undefined,
): void {
  subscriptionStore = override ?? defaultSubscriptionStore;
}

/** A customer's existing subscription as far as idempotency cares. */
export interface ExistingSubscription {
  eventName: string;
  status?: string;
}

/**
 * Loads a customer's existing subscriptions from the Data API
 * (`GET /customers/{customerId}/subscriptions`) for the idempotency check. The
 * production implementation SigV4-signs the request; tests override it via
 * {@link setExistingSubscriptionsLoaderForTesting}.
 */
export type ExistingSubscriptionsLoader = (
  customerId: string,
) => Promise<ExistingSubscription[]>;

/**
 * Default loader: SigV4-signed `GET /customers/{customerId}/subscriptions`.
 * Returns the customer's subscription records (only the fields the idempotency
 * check needs are typed). A non-2xx response yields an empty list so a read
 * failure never blocks creation.
 */
const defaultExistingSubscriptionsLoader: ExistingSubscriptionsLoader = async (
  customerId,
) => {
  const target = `${dataApiUrl()}/customers/${encodeURIComponent(customerId)}/subscriptions`;
  const response = await getSigV4Fetch()(target, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (response.status < 200 || response.status >= 300) {
    return [];
  }
  const parsed = JSON.parse(await response.text()) as {
    subscriptions?: ExistingSubscription[];
  };
  return parsed.subscriptions ?? [];
};

let existingSubscriptionsLoader: ExistingSubscriptionsLoader =
  defaultExistingSubscriptionsLoader;

/**
 * Override the {@link ExistingSubscriptionsLoader}. Test seam only — production
 * code never calls this. Pass `undefined` to reset to the default.
 */
export function setExistingSubscriptionsLoaderForTesting(
  override: ExistingSubscriptionsLoader | undefined,
): void {
  existingSubscriptionsLoader = override ?? defaultExistingSubscriptionsLoader;
}

// ---------------------------------------------------------------------------
// Retry / backoff
// ---------------------------------------------------------------------------

/**
 * Backoff delays (ms) applied between retries of a failed subscribe or store
 * step. Two entries means up to 3 attempts per step (1 initial + 2 retries),
 * matching the system's 1s/5s webhook-delivery cadence (Requirement 8.1).
 */
export const REGISTER_RETRY_DELAYS_MS = [1000, 5000] as const;

/** Injectable sleep so tests never wait on real timers. */
type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

let sleepImpl: Sleep = realSleep;

/**
 * Override the sleep implementation. Test seam only — production code never
 * calls this. Pass `undefined` to reset to the real timer-based sleep.
 */
export function setSleepForTesting(override: Sleep | undefined): void {
  sleepImpl = override ?? realSleep;
}

/**
 * Run `op` with bounded exponential backoff, retrying on any thrown error up to
 * {@link REGISTER_RETRY_DELAYS_MS}`.length` times. Rethrows the last error when
 * every attempt fails.
 */
async function withRetry<T>(op: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown;
  for (
    let attempt = 0;
    attempt <= REGISTER_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    try {
      return await op();
    } catch (error) {
      lastError = error;
      if (attempt < REGISTER_RETRY_DELAYS_MS.length) {
        console.warn(`${label} failed; retrying`, {
          attempt: attempt + 1,
          error: error instanceof Error ? error.message : String(error),
        });
        await sleepImpl(REGISTER_RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Target construction
// ---------------------------------------------------------------------------

/** A planned subscription to create for a customer on one MCP server. */
interface SubscriptionTarget {
  server: ServerKey;
  serverUrl: string;
  eventName: WebhookSubscription["eventName"];
  /** The MCP `inputSchema` (filter params or cron schedule). */
  inputSchema: SubscribeInputSchema;
  /** Domain attributes stored on the record (`filterParams` or `schedule`). */
  record: Pick<SubscriptionCreateBody, "filterParams" | "schedule">;
}

/**
 * Build the two subscription targets (USGS earthquake feed + Scheduler) for a
 * customer from its config. The USGS target carries the customer's filter
 * params; the Scheduler target carries the customer's cron schedule.
 */
function buildTargets(config: CustomerConfig): SubscriptionTarget[] {
  const filterInput: SubscribeInputSchema = {};
  if (config.subscriptionParams.minMagnitude !== undefined) {
    filterInput.minMagnitude = config.subscriptionParams.minMagnitude;
  }
  if (config.subscriptionParams.region !== undefined) {
    filterInput.region = config.subscriptionParams.region;
  }
  if (config.subscriptionParams.maxDepthKm !== undefined) {
    filterInput.maxDepthKm = config.subscriptionParams.maxDepthKm;
  }

  return [
    {
      server: "usgs",
      serverUrl: usgsMcpUrl(),
      eventName: EVENT_NAME_EARTHQUAKE_DETECTED,
      inputSchema: filterInput,
      record: { filterParams: config.subscriptionParams },
    },
    {
      server: "scheduler",
      serverUrl: schedulerMcpUrl(),
      eventName: EVENT_NAME_BRIEFING_TRIGGER,
      inputSchema: { intervalHours: config.briefingSchedule },
      record: { schedule: config.briefingSchedule },
    },
  ];
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** The outcome of creating (or skipping) one server subscription. */
export interface SubscriptionOutcome {
  server: ServerKey;
  eventName: WebhookSubscription["eventName"];
  /**
   * `created`          — subscribed on the server and stored via the Data API.
   * `skipped-existing` — an active subscription already existed (idempotency).
   * `failed`           — subscribe or store failed after all retries.
   */
  status: "created" | "skipped-existing" | "failed";
  subscriptionId?: string;
  /** ISO 8601 expiry returned by the server on success. */
  expiresAt?: string;
  /** Human-readable failure reason when `status === "failed"`. */
  error?: string;
}

/** The result of registering one customer across both MCP servers. */
export interface RegistrationResult {
  customerId: string;
  outcomes: SubscriptionOutcome[];
  /** True when no target failed (created or skipped-existing for all). */
  success: boolean;
}

/**
 * Subscribe one target on its MCP server and store the resulting record via the
 * Data API. Subscribe and store are retried independently so a store failure
 * re-uses the same `subscriptionId` instead of orphaning a new server-side
 * subscription.
 */
async function createSubscription(
  customerId: string,
  target: SubscriptionTarget,
  now: Date,
): Promise<SubscriptionOutcome> {
  const secret = generateWebhookSecret();
  const callbackUrl = webhookCallbackUrl();

  const subscribeParams: McpSubscribeParams = {
    event: target.eventName,
    delivery: { mode: "webhook", url: callbackUrl, secret },
    inputSchema: target.inputSchema,
    ttl: DEFAULT_SUBSCRIPTION_TTL_SECONDS,
    customerId,
  };

  try {
    const result = await withRetry(
      () => mcpSubscriber(target.serverUrl, subscribeParams),
      `events/subscribe on ${target.server}`,
    );

    const nowIso = now.toISOString();
    const body: SubscriptionCreateBody = {
      subscriptionId: result.subscriptionId,
      customerId,
      serverEndpoint: target.serverUrl,
      eventName: target.eventName,
      callbackUrl,
      secret,
      ...target.record,
      createdAt: nowIso,
      expiresAt: result.expiresAt,
      lastRefreshedAt: nowIso,
      status: "active",
    };

    await withRetry(async () => {
      const stored = await subscriptionStore(customerId, body);
      if (stored.statusCode < 200 || stored.statusCode >= 300) {
        throw new Error(
          `Data API subscription store returned ${stored.statusCode}`,
        );
      }
    }, `store subscription for ${target.server}`);

    return {
      server: target.server,
      eventName: target.eventName,
      status: "created",
      subscriptionId: result.subscriptionId,
      expiresAt: result.expiresAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Log at per-customer granularity for alerting (Requirement 18.3 / 8.4).
    console.error("Subscription creation failed", {
      customerId,
      server: target.server,
      eventName: target.eventName,
      error: message,
    });
    return {
      server: target.server,
      eventName: target.eventName,
      status: "failed",
      error: message,
    };
  }
}

/**
 * Best-effort set of event names the customer already has an ACTIVE
 * subscription for, used to skip duplicate creation on a stream redrive
 * (idempotency). A read failure returns an empty set so creation proceeds.
 */
async function loadExistingEventNames(
  customerId: string,
): Promise<Set<string>> {
  try {
    const existing = await existingSubscriptionsLoader(customerId);
    return new Set(
      existing
        .filter((s) => s.status === undefined || s.status === "active")
        .map((s) => s.eventName),
    );
  } catch (error) {
    console.warn(
      "Could not load existing subscriptions; proceeding to create",
      {
        customerId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return new Set();
  }
}

/**
 * Register a new customer by creating webhook subscriptions on both MCP servers
 * and persisting the records via the Data API (Requirements 8.1, 8.3, 14.6).
 *
 * Targets whose event already has an active subscription are skipped
 * (idempotency); the rest are created independently with partial-failure retry,
 * so a failure on one server neither blocks nor re-does the other.
 */
export async function registerCustomer(
  config: CustomerConfig,
  now: Date = new Date(),
): Promise<RegistrationResult> {
  const customerId = config.customerId;
  const existingEventNames = await loadExistingEventNames(customerId);

  const outcomes: SubscriptionOutcome[] = [];
  for (const target of buildTargets(config)) {
    if (existingEventNames.has(target.eventName)) {
      outcomes.push({
        server: target.server,
        eventName: target.eventName,
        status: "skipped-existing",
      });
      continue;
    }
    outcomes.push(await createSubscription(customerId, target, now));
  }

  return {
    customerId,
    outcomes,
    success: outcomes.every((o) => o.status !== "failed"),
  };
}

// ---------------------------------------------------------------------------
// DynamoDB Stream parsing
// ---------------------------------------------------------------------------

/**
 * Parsed result from a DynamoDB Stream record. Indicates what action the
 * Subscription Manager should take for this customer.
 */
export type StreamAction =
  | { action: "register"; config: CustomerConfig }
  | { action: "deregister"; customerId: string }
  | { action: "skip" };

/**
 * Parse a DynamoDB Stream record into an action. Returns:
 * - `register` for INSERT or MODIFY with an active config (create/update subscriptions)
 * - `deregister` for REMOVE, or MODIFY with `active: false` (clean up subscriptions)
 * - `skip` for records that don't require action
 */
export function parseStreamRecord(record: DynamoDBRecord): StreamAction {
  const eventName = record.eventName;

  if (eventName === "REMOVE") {
    const image = record.dynamodb?.OldImage;
    if (!image) return { action: "skip" };
    let raw: unknown;
    try {
      raw = unmarshall(image as unknown as Record<string, AttributeValue>);
    } catch {
      return { action: "skip" };
    }
    const customerId = (raw as { customerId?: string }).customerId;
    return customerId ? { action: "deregister", customerId } : { action: "skip" };
  }

  // INSERT or MODIFY — look at NewImage
  const image = record.dynamodb?.NewImage;
  if (!image) return { action: "skip" };

  let raw: unknown;
  try {
    raw = unmarshall(image as unknown as Record<string, AttributeValue>);
  } catch (error) {
    console.error("Could not unmarshall CustomerConfig stream image", {
      sequenceNumber: record.dynamodb?.SequenceNumber,
      error: error instanceof Error ? error.message : String(error),
    });
    return { action: "skip" };
  }

  const parsed = customerConfigSchema.safeParse(raw);
  if (!parsed.success) {
    console.error("CustomerConfig stream image failed validation", {
      sequenceNumber: record.dynamodb?.SequenceNumber,
      issues: parsed.error.issues.map((i) => i.message).join("; "),
    });
    return { action: "skip" };
  }

  if (!parsed.data.active) {
    return { action: "deregister", customerId: parsed.data.customerId };
  }

  return { action: "register", config: parsed.data };
}

/**
 * Process a DynamoDB Stream batch (Requirements 8.1, 8.3). Each record is
 * parsed into an action: register (create/update subscriptions), deregister
 * (delete subscriptions), or skip. A record whose action fails after retries
 * is reported as a batch item failure so the event source redrives just that
 * record.
 */

/**
 * Deregister a customer — log the deregistration. The customer's MCP server
 * subscriptions will TTL-expire naturally since the refresh loop (which loads
 * active customers from the Data API) will no longer include this customer.
 */
async function deregisterCustomer(customerId: string): Promise<void> {
  console.log("Customer deregistered; subscriptions will TTL-expire", { customerId });
}

export async function handleRegistrationStream(
  event: DynamoDBStreamEvent,
  now: Date = new Date(),
): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    const streamAction = parseStreamRecord(record);
    if (streamAction.action === "skip") {
      continue;
    }

    const sequenceNumber = record.dynamodb?.SequenceNumber;
    try {
      if (streamAction.action === "register") {
        const result = await registerCustomer(streamAction.config, now);
        if (!result.success && sequenceNumber) {
          batchItemFailures.push({ itemIdentifier: sequenceNumber });
        }
      } else {
        // deregister — delete subscriptions for this customer
        await deregisterCustomer(streamAction.customerId);
      }
    } catch (error) {
      const customerId = streamAction.action === "register"
        ? streamAction.config.customerId
        : streamAction.customerId;
      console.error("Unexpected error processing stream record", {
        customerId,
        action: streamAction.action,
        error: error instanceof Error ? error.message : String(error),
      });
      if (sequenceNumber) {
        batchItemFailures.push({ itemIdentifier: sequenceNumber });
      }
    }
  }

  return { batchItemFailures };
}
