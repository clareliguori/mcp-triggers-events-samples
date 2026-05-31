/**
 * Subscription lifecycle persistence shared by both MCP servers: load active
 * subscriptions, create on `events/subscribe`, refresh, and delete on
 * `events/unsubscribe`.
 *
 * The two servers differ only in the per-server domain attributes a created
 * subscription carries (MCP Server 1 stores `filterParams`; MCP Server 2 stores
 * a cron `schedule`) and the `serverEndpoint` recorded on the record. Those are
 * lifted out as {@link CreateSubscriptionInputs.domainAttributes} and
 * {@link CreateSubscriptionInputs.serverEndpoint} so the create logic — minting
 * the id, KMS-encrypting the client-supplied secret bound to that id, and the
 * persisted record shape — is written once here.
 */

import {
  DeleteCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

import type { SubscribeResult, WebhookSubscription } from "@mcp-events/shared";
import {
  DEFAULT_SUBSCRIPTION_TTL_SECONDS,
  encryptSubscriptionSecret,
} from "@mcp-events/shared";

import { getDocumentClient, getKmsClient } from "./clients.js";
import { secretKeyId, subscriptionsTableName } from "./env.js";

/**
 * The Subscriptions table item an MCP server writes. It is structurally a
 * {@link WebhookSubscription} plus the numeric `ttl` attribute DynamoDB uses to
 * auto-expire stale rows. `customerId` is optional here because the MCP Events
 * `events/subscribe` protocol does not carry it — the `subscriptionId ->
 * customerId` mapping is owned by the Data API's Subscriptions table (written
 * by the Subscription Manager after subscribe). When the MCP client includes a
 * `customerId` extension field it is stored; otherwise it is omitted.
 */
export type StoredSubscription = Omit<WebhookSubscription, "customerId"> & {
  customerId?: string;
  /** DynamoDB TTL — epoch seconds, mirrors `expiresAt`. */
  ttl: number;
};

/** Whether a subscription is currently eligible to receive deliveries. */
export function isSubscriptionActive(
  subscription: WebhookSubscription,
  nowMs: number,
): boolean {
  return (
    subscription.status === "active" &&
    Date.parse(subscription.expiresAt) > nowMs
  );
}

/**
 * Load every subscription from the table and keep only those that are currently
 * active and not yet expired (Requirement 1.2; "expire based on expiresAt").
 * Demo-scale single Scan — a production server would page / use a status GSI.
 */
export async function loadActiveSubscriptions(
  nowMs: number,
): Promise<WebhookSubscription[]> {
  const result = await getDocumentClient().send(
    new ScanCommand({ TableName: subscriptionsTableName() }),
  );
  const items = (result.Items ?? []) as WebhookSubscription[];
  return items.filter((item) => isSubscriptionActive(item, nowMs));
}

/**
 * Inputs needed to create a subscription on `events/subscribe`. The
 * per-server bits — the recorded `serverEndpoint` and the domain-specific
 * attributes (`filterParams` for MCP Server 1, `schedule` for MCP Server 2) —
 * are resolved by the caller and supplied here.
 */
export interface CreateSubscriptionInputs {
  event: WebhookSubscription["eventName"];
  callbackUrl: string;
  secret: string;
  ttlSeconds: number;
  customerId?: string;
  /** Caller-resolved per-server endpoint stored on the record. */
  serverEndpoint: string;
  /** Per-server domain attributes, e.g. `{ filterParams }` or `{ schedule }`. */
  domainAttributes?: Record<string, unknown>;
}

/**
 * Create a subscription on `events/subscribe` (Requirements 14.3, 14.5, 17.5):
 * mint a fresh `subscriptionId`, KMS-encrypt the client-supplied secret bound to
 * that id, persist an active {@link StoredSubscription}, and return the
 * {@link SubscribeResult}. The server stores and later signs with the supplied
 * secret; it never generates one.
 */
export async function createSubscription(
  inputs: CreateSubscriptionInputs,
  now: Date = new Date(),
): Promise<SubscribeResult> {
  const subscriptionId = randomUUID();
  const expiresAtMs = now.getTime() + inputs.ttlSeconds * 1000;
  const expiresAt = new Date(expiresAtMs).toISOString();
  const nowIso = now.toISOString();

  const encryptedSecret = await encryptSubscriptionSecret(
    getKmsClient(),
    secretKeyId(),
    subscriptionId,
    inputs.secret,
  );

  const record: StoredSubscription = {
    subscriptionId,
    ...(inputs.customerId !== undefined
      ? { customerId: inputs.customerId }
      : {}),
    serverEndpoint: inputs.serverEndpoint,
    eventName: inputs.event,
    callbackUrl: inputs.callbackUrl,
    encryptedSecret,
    ...inputs.domainAttributes,
    createdAt: nowIso,
    expiresAt,
    lastRefreshedAt: nowIso,
    status: "active",
    ttl: Math.floor(expiresAtMs / 1000),
  };

  await getDocumentClient().send(
    new PutCommand({
      TableName: subscriptionsTableName(),
      Item: record,
    }),
  );

  return { subscriptionId, expiresAt };
}

/**
 * Refresh an existing subscription's lifetime (Requirement 15.3 support):
 * extend `expiresAt`/`ttl`, bump `lastRefreshedAt`, and (re)set `status` to
 * active on a record that still exists. Returns the new `expiresAt`, or
 * `undefined` when the subscription is gone (so the caller can re-create it).
 */
export async function refreshSubscription(
  subscriptionId: string,
  ttlSeconds: number = DEFAULT_SUBSCRIPTION_TTL_SECONDS,
  now: Date = new Date(),
): Promise<string | undefined> {
  const expiresAtMs = now.getTime() + ttlSeconds * 1000;
  const expiresAt = new Date(expiresAtMs).toISOString();

  try {
    await getDocumentClient().send(
      new UpdateCommand({
        TableName: subscriptionsTableName(),
        Key: { subscriptionId },
        UpdateExpression:
          "SET expiresAt = :e, #ttl = :t, lastRefreshedAt = :r, #status = :s",
        ConditionExpression: "attribute_exists(subscriptionId)",
        ExpressionAttributeNames: { "#ttl": "ttl", "#status": "status" },
        ExpressionAttributeValues: {
          ":e": expiresAt,
          ":t": Math.floor(expiresAtMs / 1000),
          ":r": now.toISOString(),
          ":s": "active",
        },
      }),
    );
    return expiresAt;
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "ConditionalCheckFailedException"
    ) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Remove a subscription on `events/unsubscribe`. DeleteItem is idempotent, so
 * unsubscribing an already-absent subscription is a no-op success.
 */
export async function deleteSubscription(
  subscriptionId: string,
): Promise<void> {
  await getDocumentClient().send(
    new DeleteCommand({
      TableName: subscriptionsTableName(),
      Key: { subscriptionId },
    }),
  );
}
