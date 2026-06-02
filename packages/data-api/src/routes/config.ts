/**
 * CustomerConfig CRUD route handlers for `/customers/:customerId/config`
 * (task 4.3).
 *
 * These back the webapp's self-service configuration screen and the agent's
 * config lookups. Persistence is a single DynamoDB table (partition key
 * `customerId`) whose name is supplied by the CDK stack via the
 * `CUSTOMER_CONFIG_TABLE_NAME` environment variable.
 *
 * Behavior (Requirements 9.5, 16.1-16.6):
 * - GET    — read the stored {@link CustomerConfig}; 404 when absent.
 * - PUT    — validate the body with the shared zod schema (400 on failure) and
 *            upsert the config with `active: true`, stamping `createdAt` on
 *            first create only and `updatedAt` on every write. Writing a new
 *            customer fires the table's DynamoDB Stream, which the Subscription
 *            Manager consumes to create subscriptions.
 * - DELETE  — soft delete: set `active: false` (and `updatedAt`); 404 when the
 *            config does not exist. The Subscription Manager later cleans up
 *            the customer's subscriptions.
 *
 * Authorization (Cognito caller's `sub` == `customerId`, or an IAM backend
 * caller) is enforced by the handler before dispatch, so these handlers focus
 * on validation and persistence. `customerId` is still validated as a UUID v4
 * here to satisfy Requirement 16.1.
 */

import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { CustomerConfig } from "@mcp-events/shared";
import {
  customerConfigInputSchema,
  customerIdSchema,
} from "@mcp-events/shared";
import { z } from "zod";

import { badRequest, notFound } from "../http.js";
import type { ApiResult, RouteContext } from "../types.js";

/**
 * Lazily-created DynamoDB document client. A module-level singleton so the
 * Lambda reuses one client across warm invocations. `removeUndefinedValues`
 * lets optional `subscriptionParams` fields be omitted without marshalling
 * errors.
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
 * calls this. Pass `undefined` to reset back to the lazily-created client.
 */
export function setDocumentClientForTesting(
  client: DynamoDBDocumentClient | undefined,
): void {
  documentClient = client;
}

/** Resolve the CustomerConfig table name from the environment. */
function tableName(): string {
  const name = process.env.CUSTOMER_CONFIG_TABLE_NAME;
  if (!name) {
    // Misconfiguration — surfaces as a 500 via the handler's catch-all.
    throw new Error("CUSTOMER_CONFIG_TABLE_NAME is not set");
  }
  return name;
}

/**
 * Validate and return the `customerId` path parameter.
 *
 * @throws HttpError 400 when it is missing or not a UUID (Requirement 16.1).
 */
function requireCustomerId(ctx: RouteContext): string {
  const result = customerIdSchema.safeParse(ctx.pathParameters.customerId);
  if (!result.success) {
    throw badRequest("customerId must be a valid UUID");
  }
  return result.data;
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

/** GET /customers/:customerId/config — read CustomerConfig from DynamoDB. */
export async function getConfig(ctx: RouteContext): Promise<ApiResult> {
  const customerId = requireCustomerId(ctx);

  const result = await getDocumentClient().send(
    new GetCommand({
      TableName: tableName(),
      Key: { customerId },
    }),
  );

  if (!result.Item) {
    throw notFound(`No config for customer ${customerId}`);
  }

  return { statusCode: 200, body: result.Item as CustomerConfig };
}

/**
 * PUT /customers/:customerId/config — create or update a CustomerConfig.
 *
 * Validates the body against the shared input schema (400 on failure), then
 * upserts with `active: true`. `createdAt` is stamped only on first create
 * (via `if_not_exists`); `updatedAt` is refreshed on every write. Returns the
 * stored config.
 */
export async function putConfig(ctx: RouteContext): Promise<ApiResult> {
  const customerId = requireCustomerId(ctx);

  const parsed = customerConfigInputSchema.safeParse(ctx.body);
  if (!parsed.success) {
    throw badRequest(formatZodError(parsed.error));
  }
  const input = parsed.data;

  const now = new Date().toISOString();

  const result = await getDocumentClient().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { customerId },
      UpdateExpression:
        "SET #displayName = :displayName, " +
        "#subscriptionParams = :subscriptionParams, " +
        "#briefingPrompt = :briefingPrompt, " +
        "#briefingSchedule = :briefingSchedule, " +
        "#active = :active, " +
        "#updatedAt = :now, " +
        "#createdAt = if_not_exists(#createdAt, :now)",
      ExpressionAttributeNames: {
        "#displayName": "displayName",
        "#subscriptionParams": "subscriptionParams",
        "#briefingPrompt": "briefingPrompt",
        "#briefingSchedule": "briefingSchedule",
        "#active": "active",
        "#updatedAt": "updatedAt",
        "#createdAt": "createdAt",
      },
      ExpressionAttributeValues: {
        ":displayName": input.displayName,
        ":subscriptionParams": input.subscriptionParams,
        ":briefingPrompt": input.briefingPrompt,
        ":briefingSchedule": input.briefingSchedule,
        ":active": true,
        ":now": now,
      },
      ReturnValues: "ALL_NEW",
    }),
  );

  return { statusCode: 200, body: result.Attributes as CustomerConfig };
}

/**
 * DELETE /customers/:customerId/config — soft delete.
 *
 * Sets `active: false` and refreshes `updatedAt` (the record is retained so the
 * Subscription Manager can clean up the customer's subscriptions). Returns 404
 * when there is no config to deactivate.
 */
export async function deleteConfig(ctx: RouteContext): Promise<ApiResult> {
  const customerId = requireCustomerId(ctx);

  const now = new Date().toISOString();

  try {
    await getDocumentClient().send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { customerId },
        UpdateExpression: "SET #active = :inactive, #updatedAt = :now",
        ConditionExpression: "attribute_exists(customerId)",
        ExpressionAttributeNames: {
          "#active": "active",
          "#updatedAt": "updatedAt",
        },
        ExpressionAttributeValues: {
          ":inactive": false,
          ":now": now,
        },
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      throw notFound(`No config for customer ${customerId}`);
    }
    throw error;
  }

  return { statusCode: 200, body: { deactivated: true } };
}
