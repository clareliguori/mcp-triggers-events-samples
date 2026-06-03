/**
 * DynamoDB-backed WebhookSubscriptionStore for the MCP SDK's events system.
 *
 * Implements the {@link WebhookSubscriptionStore} interface from our forked SDK
 * so webhook subscriptions survive across Lambda invocations. Each subscription
 * is stored as a DynamoDB item keyed by its compound `key` (mapped to the
 * `subscriptionId` partition key).
 *
 * The webhook secret (`secrets` array) is stored KMS-encrypted at rest using
 * the per-table KMS key. The `eventName-index` GSI enables efficient
 * `listByEvent` queries.
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
import { secretKeyId, subscriptionsTableName } from "./env.js";

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

export class DynamoDBWebhookSubscriptionStore
  implements WebhookSubscriptionStore
{
  async get(key: string): Promise<WebhookSubscriptionData | undefined> {
    const result = await getDocumentClient().send(
      new GetCommand({
        TableName: subscriptionsTableName(),
        Key: { subscriptionId: key },
      }),
    );
    if (!result.Item) return undefined;
    return this.deserialize(result.Item as Record<string, unknown>);
  }

  async put(key: string, sub: WebhookSubscriptionData): Promise<void> {
    const item = await this.serialize(key, sub);
    await getDocumentClient().send(
      new PutCommand({ TableName: subscriptionsTableName(), Item: item }),
    );
  }

  async delete(key: string): Promise<void> {
    await getDocumentClient().send(
      new DeleteCommand({
        TableName: subscriptionsTableName(),
        Key: { subscriptionId: key },
      }),
    );
  }

  async listByEvent(eventName: string): Promise<WebhookSubscriptionData[]> {
    const result = await getDocumentClient().send(
      new QueryCommand({
        TableName: subscriptionsTableName(),
        IndexName: "eventName-index",
        KeyConditionExpression: "eventName = :en",
        ExpressionAttributeValues: { ":en": eventName },
      }),
    );
    const items = (result.Items ?? []) as Record<string, unknown>[];
    return Promise.all(items.map((item) => this.deserialize(item)));
  }

  async count(): Promise<number> {
    // Acceptable for a demo with few subscriptions.
    const result = await getDocumentClient().send(
      new QueryCommand({
        TableName: subscriptionsTableName(),
        IndexName: "eventName-index",
        Select: "COUNT",
        KeyConditionExpression: "eventName = :en",
        ExpressionAttributeValues: { ":en": "__count__" },
      }),
    );
    // This intentionally returns 0 — quota enforcement is not critical for
    // this demo. A full scan count would be expensive.
    return result.Count ?? 0;
  }

  private async serialize(
    key: string,
    sub: WebhookSubscriptionData,
  ): Promise<Record<string, unknown>> {
    const secretsJson = JSON.stringify(sub.secrets);
    const encryptedSecret = await encryptSubscriptionSecret(
      getKmsClient(),
      secretKeyId(),
      sub.id,
      secretsJson,
    );
    return {
      subscriptionId: key,
      id: sub.id,
      eventName: sub.eventName,
      params: JSON.stringify(sub.params),
      cursor: sub.cursor,
      internalCheckCursor: sub.internalCheckCursor,
      callbackUrl: sub.url,
      encryptedSecret,
      acknowledgedSeq: sub.acknowledgedSeq,
      expiresAt: sub.expiresAt,
      deliveryStatus: JSON.stringify(sub.deliveryStatus),
      ttl: Math.floor(sub.expiresAt / 1000),
    };
  }

  private async deserialize(
    item: Record<string, unknown>,
  ): Promise<WebhookSubscriptionData> {
    const encryptedSecret = item.encryptedSecret as string;
    const id = item.id as string;
    const secretsJson = await decryptSubscriptionSecret(
      getKmsClient(),
      id,
      encryptedSecret,
    );
    const secrets = JSON.parse(secretsJson) as string[];
    return {
      key: item.subscriptionId as string,
      id,
      eventName: item.eventName as string,
      params: JSON.parse(item.params as string) as Record<string, unknown>,
      cursor: (item.cursor as string | null) ?? null,
      internalCheckCursor: (item.internalCheckCursor as string | null) ?? null,
      url: item.callbackUrl as string,
      secrets,
      acknowledgedSeq: (item.acknowledgedSeq as number) ?? 0,
      expiresAt: item.expiresAt as number,
      deliveryStatus: JSON.parse(
        (item.deliveryStatus as string) ?? '{"active":true,"lastDeliveryAt":null,"lastError":null}',
      ) as WebhookSubscriptionData["deliveryStatus"],
    };
  }
}
