/**
 * Subscription route handlers (task 4.4).
 *
 * Routes:
 * - GET    /subscriptions/:subscriptionId                  (backend / IAM)
 * - PUT    /subscriptions/:subscriptionId                  (backend / IAM)
 * - GET    /customers/:customerId/subscriptions            (backend / IAM)
 * - POST   /customers/:customerId/subscriptions            (backend / IAM)
 *
 * Persistence is the Subscriptions DynamoDB table (partition key
 * `subscriptionId`, GSI on `customerId`) whose name and index name are supplied
 * by the CDK stack via the `SUBSCRIPTIONS_TABLE_NAME` and
 * `SUBSCRIPTIONS_BY_CUSTOMER_INDEX` environment variables.
 *
 * Secret handling (Requirement 17.5): a subscription's Standard Webhooks
 * `whsec_` signing secret is client-side field-encrypted with the DataApiStack
 * customer-managed KMS key (env var `SUBSCRIPTION_SECRET_KEY_ID`) BEFORE it is
 * written to DynamoDB, so the table only ever holds ciphertext in the
 * `encryptedSecret` attribute. The ciphertext is bound to its `subscriptionId`
 * via a KMS encryption context (see `@mcp-events/shared` crypto helpers).
 * - On write (POST/PUT) the caller supplies the plaintext `secret`; this handler
 *   encrypts it to `encryptedSecret` and never persists the plaintext.
 * - On read (GET by id, GET by customerId) this handler decrypts
 *   `encryptedSecret` and returns the plaintext `whsec_` to the caller as the
 *   `secret` field (the opaque `encryptedSecret` is not returned).
 *
 * Authorization (Cognito `sub` == `customerId`, or an IAM backend caller) is
 * enforced by the handler before dispatch, so these handlers focus on
 * validation, encryption, and persistence.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { WebhookSubscription } from "@mcp-events/shared";
import {
  decryptSubscriptionSecret,
  encryptSubscriptionSecret,
  uuidV4Schema,
  webhookSubscriptionSchema,
  whsecSecretSchema,
} from "@mcp-events/shared";
import { z } from "zod";

import { badRequest, notFound } from "../http.js";
import type { ApiResult, RouteContext } from "../types.js";

/**
 * Caller-facing shape of a subscription: the stored {@link WebhookSubscription}
 * with the opaque `encryptedSecret` replaced by the decrypted plaintext
 * `secret` (`whsec_`).
 */
export type SubscriptionResponse = Omit<
  WebhookSubscription,
  "encryptedSecret"
> & {
  /** Decrypted Standard Webhooks signing secret (`whsec_`). */
  secret: string;
};

/**
 * Request body for creating a subscription record (POST). Mirrors the stored
 * {@link WebhookSubscription} but carries the plaintext `secret` instead of the
 * encrypted-at-rest `encryptedSecret`.
 */
const subscriptionCreateSchema = webhookSubscriptionSchema
  .omit({ encryptedSecret: true })
  .extend({ secret: whsecSecretSchema });

/**
 * Request body for updating a subscription record (PUT). Every field is
 * optional; only the fields present are written. A present `secret` is
 * re-encrypted. `subscriptionId` is taken from the path, never the body.
 */
const subscriptionUpdateSchema = subscriptionCreateSchema
  .omit({ subscriptionId: true })
  .partial();

/**
 * Lazily-created DynamoDB document client (module-level singleton so the Lambda
 * reuses one client across warm invocations). `removeUndefinedValues` lets
 * optional fields (`filterParams`, `schedule`) be omitted cleanly.
 */
let documentClient: DynamoDBDocumentClient | undefined;

/** Return the shared {@link DynamoDBDocumentClient}, creating it on first use. */
function getDocumentClient(): DynamoDBDocumentClient {
  if (!documentClient) {
    documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return documentClient;
}

/**
 * Override the DynamoDB document client. Test seam only — production code never
 * calls this. Pass `undefined` to reset to the lazily-created client.
 */
export function setDocumentClientForTesting(
  client: DynamoDBDocumentClient | undefined,
): void {
  documentClient = client;
}

/** Lazily-created KMS client (module-level singleton). */
let kmsClient: KMSClient | undefined;

/** Return the shared {@link KMSClient}, creating it on first use. */
function getKmsClient(): KMSClient {
  if (!kmsClient) {
    kmsClient = new KMSClient({});
  }
  return kmsClient;
}

/**
 * Override the KMS client. Test seam only — production code never calls this.
 * Pass `undefined` to reset to the lazily-created client.
 */
export function setKmsClientForTesting(client: KMSClient | undefined): void {
  kmsClient = client;
}

/** Resolve the Subscriptions table name from the environment. */
function tableName(): string {
  const name = process.env.SUBSCRIPTIONS_TABLE_NAME;
  if (!name) {
    throw new Error("SUBSCRIPTIONS_TABLE_NAME is not set");
  }
  return name;
}

/** Resolve the Subscriptions `by-customer` GSI name from the environment. */
function byCustomerIndexName(): string {
  const name = process.env.SUBSCRIPTIONS_BY_CUSTOMER_INDEX;
  if (!name) {
    throw new Error("SUBSCRIPTIONS_BY_CUSTOMER_INDEX is not set");
  }
  return name;
}

/** Resolve the KMS key id/arn used to encrypt subscription secrets. */
function secretKeyId(): string {
  const keyId = process.env.SUBSCRIPTION_SECRET_KEY_ID;
  if (!keyId) {
    throw new Error("SUBSCRIPTION_SECRET_KEY_ID is not set");
  }
  return keyId;
}

/** Flatten a {@link z.ZodError} into a single human-readable message. */
function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

/**
 * Validate and return the `subscriptionId` path parameter.
 *
 * @throws HttpError 400 when it is missing or not a UUID v4.
 */
function requireSubscriptionId(ctx: RouteContext): string {
  const result = uuidV4Schema.safeParse(ctx.pathParameters.subscriptionId);
  if (!result.success) {
    throw badRequest("subscriptionId must be a valid UUID v4");
  }
  return result.data;
}

/**
 * Validate and return the `customerId` path parameter.
 *
 * @throws HttpError 400 when it is missing or not a UUID v4 (Requirement 16.1).
 */
function requireCustomerId(ctx: RouteContext): string {
  const result = uuidV4Schema.safeParse(ctx.pathParameters.customerId);
  if (!result.success) {
    throw badRequest("customerId must be a valid UUID v4");
  }
  return result.data;
}

/**
 * Decrypt a stored subscription record's secret and return the caller-facing
 * shape (plaintext `secret`, no `encryptedSecret`).
 */
async function toResponse(
  item: WebhookSubscription,
): Promise<SubscriptionResponse> {
  const secret = await decryptSubscriptionSecret(
    getKmsClient(),
    item.subscriptionId,
    item.encryptedSecret,
  );
  const { encryptedSecret: _encryptedSecret, ...rest } = item;
  return { ...rest, secret };
}

/**
 * GET /subscriptions/:subscriptionId — resolve a subscription by id.
 *
 * Used by the Serverless Agent (IAM SigV4) to resolve `subscriptionId` ->
 * `customerId` for event routing. Returns the {@link WebhookSubscription} with
 * the decrypted plaintext `secret`; 404 when absent.
 */
export async function getSubscription(ctx: RouteContext): Promise<ApiResult> {
  const subscriptionId = requireSubscriptionId(ctx);

  const result = await getDocumentClient().send(
    new GetCommand({
      TableName: tableName(),
      Key: { subscriptionId },
    }),
  );

  if (!result.Item) {
    throw notFound(`No subscription ${subscriptionId}`);
  }

  const subscription = await toResponse(result.Item as WebhookSubscription);
  return { statusCode: 200, body: subscription };
}

/**
 * GET /customers/:customerId/subscriptions — list a customer's subscriptions.
 *
 * Queries the `by-customer` GSI and returns every subscription for the
 * customer with each secret decrypted. Returns `{ subscriptions: [] }` when the
 * customer has none.
 */
export async function listSubscriptions(ctx: RouteContext): Promise<ApiResult> {
  const customerId = requireCustomerId(ctx);

  const result = await getDocumentClient().send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: byCustomerIndexName(),
      KeyConditionExpression: "#customerId = :customerId",
      ExpressionAttributeNames: { "#customerId": "customerId" },
      ExpressionAttributeValues: { ":customerId": customerId },
    }),
  );

  const items = (result.Items ?? []) as WebhookSubscription[];
  const subscriptions = await Promise.all(
    items.map((item) => toResponse(item)),
  );

  return { statusCode: 200, body: { subscriptions } };
}

/**
 * POST /customers/:customerId/subscriptions — create a subscription record.
 *
 * Validates the body (400 on failure), enforces that the body `customerId`
 * matches the path, encrypts the plaintext `secret` into `encryptedSecret`
 * (bound to `subscriptionId`), and writes the record. Returns
 * `{ subscriptionId }`.
 */
export async function createSubscription(
  ctx: RouteContext,
): Promise<ApiResult> {
  const customerId = requireCustomerId(ctx);

  const parsed = subscriptionCreateSchema.safeParse(ctx.body);
  if (!parsed.success) {
    throw badRequest(formatZodError(parsed.error));
  }
  const input = parsed.data;

  if (input.customerId !== customerId) {
    throw badRequest("body customerId does not match path customerId");
  }

  const { secret, ...rest } = input;
  const encryptedSecret = await encryptSubscriptionSecret(
    getKmsClient(),
    secretKeyId(),
    input.subscriptionId,
    secret,
  );

  const record: WebhookSubscription = { ...rest, encryptedSecret };

  await getDocumentClient().send(
    new PutCommand({
      TableName: tableName(),
      Item: record,
    }),
  );

  return { statusCode: 201, body: { subscriptionId: input.subscriptionId } };
}

/**
 * PUT /subscriptions/:subscriptionId — update mutable subscription fields.
 *
 * Used by the Subscription Manager to refresh `expiresAt`/`lastRefreshedAt` and
 * optionally rotate the secret. Validates a partial body (400 on failure),
 * re-encrypts a present `secret`, updates only the supplied fields against an
 * existing record (404 when absent), and returns the updated subscription with
 * its decrypted `secret`.
 */
export async function putSubscription(ctx: RouteContext): Promise<ApiResult> {
  const subscriptionId = requireSubscriptionId(ctx);

  const parsed = subscriptionUpdateSchema.safeParse(ctx.body);
  if (!parsed.success) {
    throw badRequest(formatZodError(parsed.error));
  }
  const updates = parsed.data;

  // Build the attribute map to write, encrypting a rotated secret in place.
  const attributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (key === "secret") {
      continue;
    }
    attributes[key] = value;
  }
  if (updates.secret !== undefined) {
    attributes.encryptedSecret = await encryptSubscriptionSecret(
      getKmsClient(),
      secretKeyId(),
      subscriptionId,
      updates.secret,
    );
  }

  const keys = Object.keys(attributes);
  if (keys.length === 0) {
    throw badRequest("no updatable fields supplied");
  }

  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const assignments = keys.map((key, i) => {
    names[`#f${i}`] = key;
    values[`:v${i}`] = attributes[key];
    return `#f${i} = :v${i}`;
  });

  let result;
  try {
    result = await getDocumentClient().send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { subscriptionId },
        UpdateExpression: `SET ${assignments.join(", ")}`,
        ConditionExpression: "attribute_exists(subscriptionId)",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      }),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "ConditionalCheckFailedException"
    ) {
      throw notFound(`No subscription ${subscriptionId}`);
    }
    throw error;
  }

  const subscription = await toResponse(
    result.Attributes as WebhookSubscription,
  );
  return { statusCode: 200, body: subscription };
}
