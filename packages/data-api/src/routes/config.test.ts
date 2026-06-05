/**
 * Unit tests for the CustomerConfig CRUD route handlers (task 4.3).
 *
 * The DynamoDB document client is mocked with `aws-sdk-client-mock` so the
 * tests exercise the real handler logic (validation, key construction, update
 * expressions, status/shape mapping) without touching AWS. Covered:
 * - GET found / not-found,
 * - PUT valid (sets `active: true` + `createdAt`/`updatedAt`),
 * - PUT invalid body -> 400,
 * - PUT / GET / DELETE with a non-UUID customerId -> 400,
 * - DELETE soft-deletes (sets `active: false`) and 404s when absent.
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
import type { CustomerConfigInput } from "@mcp-events/shared";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deleteConfig,
  getConfig,
  putConfig,
  setDocumentClientForTesting,
} from "./config.js";
import { HttpError } from "../http.js";
import type { AuthContext, RouteContext } from "../types.js";

const TABLE_NAME = "test-customer-config";
const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";

const ddbMock = mockClient(DynamoDBDocumentClient);

/** A valid CustomerConfigInput body for PUT requests. */
function validInput(): CustomerConfigInput {
  return {
    displayName: "Acme Seismology",
    subscriptionParams: { minMagnitude: 4.5, region: "pacific" },
    briefingPrompt: "Summarize notable earthquakes for the Pacific region.",
    briefingSchedule: 8,
  };
}

/** Build a RouteContext for the config routes. */
function makeContext(opts: {
  method: string;
  customerId?: string;
  body?: unknown;
}): RouteContext {
  const auth: AuthContext = {
    authType: "cognito",
    cognitoSub: opts.customerId ?? CUSTOMER_ID,
  };
  return {
    event: {} as RouteContext["event"],
    method: opts.method,
    pathParameters: { customerId: opts.customerId ?? CUSTOMER_ID },
    query: {},
    body: opts.body,
    auth,
  };
}

beforeEach(() => {
  ddbMock.reset();
  // Route the handler's lazily-created client through the mock so we control
  // every DynamoDB response.
  setDocumentClientForTesting(
    DynamoDBDocumentClient.from(new DynamoDBClient({})),
  );
  process.env.CUSTOMER_CONFIG_TABLE_NAME = TABLE_NAME;
});

afterEach(() => {
  setDocumentClientForTesting(undefined);
  delete process.env.CUSTOMER_CONFIG_TABLE_NAME;
});

afterAll(() => {
  ddbMock.restore();
});

describe("getConfig", () => {
  it("returns 200 with the stored config when found", async () => {
    const stored = {
      customerId: CUSTOMER_ID,
      ...validInput(),
      active: true,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    ddbMock.on(GetCommand).resolves({ Item: stored });

    const res = await getConfig(makeContext({ method: "GET" }));

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(stored);
    const call = ddbMock.commandCalls(GetCommand)[0];
    expect(call.args[0].input).toMatchObject({
      TableName: TABLE_NAME,
      Key: { customerId: CUSTOMER_ID },
    });
  });

  it("throws 404 when the config does not exist", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    await expect(getConfig(makeContext({ method: "GET" }))).rejects.toThrow(
      HttpError,
    );
    await expect(
      getConfig(makeContext({ method: "GET" })),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("throws 400 for a non-UUID customerId", async () => {
    await expect(
      getConfig(makeContext({ method: "GET", customerId: "not-a-uuid" })),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("putConfig", () => {
  it("upserts with active:true and createdAt/updatedAt, returns 200", async () => {
    const now = "2024-05-01T12:00:00.000Z";
    const returned = {
      customerId: CUSTOMER_ID,
      ...validInput(),
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    ddbMock.on(UpdateCommand).resolves({ Attributes: returned });

    const res = await putConfig(
      makeContext({ method: "PUT", body: validInput() }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(returned);

    const call = ddbMock.commandCalls(UpdateCommand)[0];
    const input = call.args[0].input;
    expect(input.TableName).toBe(TABLE_NAME);
    expect(input.Key).toEqual({ customerId: CUSTOMER_ID });
    expect(input.ReturnValues).toBe("ALL_NEW");
    // active is set to true, createdAt is only stamped on first create.
    expect(input.ExpressionAttributeValues?.[":active"]).toBe(true);
    expect(input.UpdateExpression).toContain("if_not_exists(#createdAt, :now)");
    expect(input.ExpressionAttributeValues?.[":now"]).toBeTypeOf("string");
  });

  it("returns 400 when the body fails validation", async () => {
    const bad = { ...validInput(), briefingSchedule: -1 };

    await expect(
      putConfig(makeContext({ method: "PUT", body: bad })),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("returns 400 when minMagnitude is out of range", async () => {
    const bad = {
      ...validInput(),
      subscriptionParams: { minMagnitude: 99 },
    };

    await expect(
      putConfig(makeContext({ method: "PUT", body: bad })),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("returns 400 for a non-UUID customerId", async () => {
    await expect(
      putConfig(
        makeContext({
          method: "PUT",
          customerId: "nope",
          body: validInput(),
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("deleteConfig", () => {
  it("soft-deletes by setting active:false and returns 200", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    const res = await deleteConfig(makeContext({ method: "DELETE" }));

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ deactivated: true });

    const call = ddbMock.commandCalls(UpdateCommand)[0];
    const input = call.args[0].input;
    expect(input.Key).toEqual({ customerId: CUSTOMER_ID });
    expect(input.ExpressionAttributeValues?.[":inactive"]).toBe(false);
    expect(input.ConditionExpression).toBe("attribute_exists(customerId)");
  });

  it("throws 404 when the config does not exist", async () => {
    ddbMock.on(UpdateCommand).rejects(
      new ConditionalCheckFailedException({
        message: "The conditional request failed",
        $metadata: {},
      }),
    );

    await expect(
      deleteConfig(makeContext({ method: "DELETE" })),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("throws 400 for a non-UUID customerId", async () => {
    await expect(
      deleteConfig(makeContext({ method: "DELETE", customerId: "bad" })),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
