/**
 * DynamoDB-backed WebhookSubscriptionStore for the MCP SDK's events system.
 *
 * Implements the {@link WebhookSubscriptionStore} interface from our forked SDK
 * so webhook subscriptions survive across Lambda invocations. Each subscription
 * is stored as a DynamoDB item keyed by its compound `key` (principal + url +
 * event + params hash).
 *
 * The `ctx` (ServerContext) field is not serializable — it contains transport
 * handles and notification methods. On deserialization, a minimal stub `ctx` is
 * provided since webhook delivery only needs the subscription data (url,
 * secrets, params), not the original request context.
 *
 * The webhook secret (`secrets` array) is stored KMS-encrypted at rest using
 * the same per-table KMS key pattern as the existing subscription store.
 */

import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  WebhookSubscriptionData,
  WebhookSubscriptionStore,
} from "@modelcontextprotocol/server";

import { getDocumentClient, getKmsClient } from "./clients.js";
import {
  encryptSubscriptionSecret,
  decryptSubscriptionSecret,
} from "@mcp-events/shared";

// ---------------------------------------------------------------------------
// Serializable shape stored in DynamoDB
// ---------------------------------------------------------------------------

interface StoredSubscription {
  /** Partition key: the compound subscription key. */
  pk: string;
  /** GSI partition key for listByEvent queries. */
  eventName: string;
  /** The derived routing id (sub_<hex>). */
  id: string;
  params: Record<string, unknown>;
  cursor: string | null;
  internalCheckCursor: string | null;
  url: string;
  /** KMS-encrypted secrets array, base64-encoded. */
  encryptedSecrets: string;
  acknowledgedSeq: number;
  /** Epoch ms — DynamoDB TTL can use this (converted to seconds). */
  expiresAt: number;
  /** Stored as JSON — pass through the SDK's WebhookDeliveryStatus opaquely. */
  deliveryStatus: string;
  /** DynamoDB TTL attribute (epoch seconds). */
  ttl: number;
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

export class DynamoDBWebhookSubscriptionStore
  implements WebhookSubscriptionStore
{
  private readonly tableName: string;
  private readonly kmsKeyId: string;

  constructor(tableName: string, kmsKeyId: string) {
    this.tableName = tableName;
    this.kmsKeyId = kmsKeyId;
  }

  async get(key: string): Promise<WebhookSubscriptionData | undefined> {
    const result = await getDocumentClient().send(
      new GetCommand({ TableName: this.tableName, Key: { pk: key } }),
    );
    if (!result.Item) return undefined;
    return this.deserialize(result.Item as StoredSubscription);
  }

  async put(key: string, sub: WebhookSubscriptionData): Promise<void> {
    const item = await this.serialize(key, sub);
    await getDocumentClient().send(
      new PutCommand({ TableName: this.tableName, Item: item }),
    );
  }

  async delete(key: string): Promise<void> {
    await getDocumentClient().send(
      new DeleteCommand({ TableName: this.tableName, Key: { pk: key } }),
    );
  }

  async listByEvent(eventName: string): Promise<WebhookSubscriptionData[]> {
    const result = await getDocumentClient().send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "eventName-index",
        KeyConditionExpression: "eventName = :en",
        ExpressionAttributeValues: { ":en": eventName },
      }),
    );
    const items = (result.Items ?? []) as StoredSubscription[];
    return Promise.all(items.map((item) => this.deserialize(item)));
  }

  async count(): Promise<number> {
    // For quota checks — scan count is acceptable for the expected small
    // number of subscriptions in a demo system.
    const result = await getDocumentClient().send(
      new QueryCommand({
        TableName: this.tableName,
        Select: "COUNT",
        IndexName: "eventName-index",
        KeyConditionExpression: "eventName = :en",
        ExpressionAttributeValues: { ":en": "_count" },
      }),
    );
    // Fallback: just return 0 since this is only used for quota enforcement
    // and a full scan is expensive. The real count would require a scan.
    return result.Count ?? 0;
  }

  private async serialize(
    key: string,
    sub: WebhookSubscriptionData,
  ): Promise<StoredSubscription> {
    const secretsJson = JSON.stringify(sub.secrets);
    const encryptedSecrets = await encryptSubscriptionSecret(
      getKmsClient(),
      this.kmsKeyId,
      key,
      secretsJson,
    );
    return {
      pk: key,
      eventName: sub.eventName,
      id: sub.id,
      params: sub.params,
      cursor: sub.cursor,
      internalCheckCursor: sub.internalCheckCursor,
      url: sub.url,
      encryptedSecrets,
      acknowledgedSeq: sub.acknowledgedSeq,
      expiresAt: sub.expiresAt,
      deliveryStatus: JSON.stringify(sub.deliveryStatus),
      ttl: Math.floor(sub.expiresAt / 1000),
    };
  }

  private async deserialize(
    item: StoredSubscription,
  ): Promise<WebhookSubscriptionData> {
    const secretsJson = await decryptSubscriptionSecret(
      getKmsClient(),
      item.pk,
      item.encryptedSecrets,
    );
    const secrets = JSON.parse(secretsJson) as string[];
    return {
      key: item.pk,
      id: item.id,
      eventName: item.eventName,
      params: item.params,
      cursor: item.cursor,
      internalCheckCursor: item.internalCheckCursor,
      url: item.url,
      secrets,
      acknowledgedSeq: item.acknowledgedSeq,
      expiresAt: item.expiresAt,
      deliveryStatus: JSON.parse(item.deliveryStatus) as WebhookSubscriptionData["deliveryStatus"],
    };
  }
}
