/**
 * Unit tests for the subscription route handlers (task 4.4).
 *
 * The DynamoDB document client and the KMS client are mocked with
 * `aws-sdk-client-mock` so the tests exercise the real handler logic
 * (validation, key construction, secret encrypt-on-write / decrypt-on-read,
 * status/shape mapping) without touching AWS. Covered:
 * - GET by id found (secret decrypted) / not-found,
 * - GET by customer (list, secrets decrypted),
 * - POST encrypts the plaintext secret before PutItem (never stores plaintext),
 * - PUT re-encrypts a rotated secret and 404s when absent,
 * - validation 400s (bad ids, bad body, customerId mismatch).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { WebhookSubscription } from "@mcp-events/shared";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSubscription,
  getSubscription,
  listSubscriptions,
  putSubscription,
  setDocumentClientForTesting,
  setKmsClientForTesting,
} from "./subscriptions.js";
import { HttpError } from "../http.js";
import type { AuthContext, RouteContext } from "../types.js";

const TABLE_NAME = "test-subscriptions";
const INDEX_NAME = "by-customer-id";
const KEY_ID = "arn:aws:kms:us-east-1:111122223333:key/test-key";
const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const SUBSCRIPTION_ID = "22222222-2222-4222-8222-222222222222";
// A structurally valid whsec_ secret: "whsec_" + base64 of 32 bytes.
const PLAINTEXT_SECRET = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const CIPHERTEXT = "Y2lwaGVydGV4dA==";

const ddbMock = mockClient(DynamoDBDocumentClient);
const kmsMock = mockClient(KMSClient);

/** A stored WebhookSubscription record (with encrypted secret at rest). */
function storedSubscription(
  overrides: Partial<WebhookSubscription> = {},
): WebhookSubscription {
  return {
    subscriptionId: SUBSCRIPTION_ID,
    customerId: CUSTOMER_ID,
    serverEndpoint: "https://usgs-mcp.example.com",
    eventName: "earthquake.detected",
    callbackUrl: "https://webhook.example.com/webhook",
    encryptedSecret: CIPHERTEXT,
    filterParams: { minMagnitude: 4.5, region: "pacific" },
    createdAt: "2024-01-01T00:00:00.000Z",
    expiresAt: "2024-02-01T00:00:00.000Z",
    lastRefreshedAt: "2024-01-01T00:00:00.000Z",
    status: "active",
    ...overrides,
  };
}

/** A valid POST body: a subscription record carrying the plaintext secret. */
function createBody(overrides: Record<string, unknown> = {}) {
  const { encryptedSecret: _drop, ...rest } = storedSubscription();
  return { ...rest, secret: PLAINTEXT_SECRET, ...overrides };
}

/** Build a RouteContext for the subscription routes. */
function makeContext(opts: {
  method: string;
  subscriptionId?: string;
  customerId?: string;
  body?: unknown;
}): RouteContext {
  const auth: AuthContext = {
    authType: "iam",
    iamArn: "arn:aws:iam::x:role/y",
  };
  const pathParameters: Record<string, string> = {};
  if (opts.subscriptionId !== undefined) {
    pathParameters.subscriptionId = opts.subscriptionId;
  }
  if (opts.customerId !== undefined) {
    pathParameters.customerId = opts.customerId;
  }
  return {
    event: {} as RouteContext["event"],
    method: opts.method,
    pathParameters,
    query: {},
    body: opts.body,
    auth,
  };
}

beforeEach(() => {
  ddbMock.reset();
  kmsMock.reset();
  setDocumentClientForTesting(
    DynamoDBDocumentClient.from(new DynamoDBClient({})),
  );
  setKmsClientForTesting(new KMSClient({}));
  process.env.SUBSCRIPTIONS_TABLE_NAME = TABLE_NAME;
  process.env.SUBSCRIPTIONS_BY_CUSTOMER_INDEX = INDEX_NAME;
  process.env.SUBSCRIPTION_SECRET_KEY_ID = KEY_ID;

  // Default KMS behavior: Encrypt -> ciphertext, Decrypt -> plaintext secret.
  kmsMock.on(EncryptCommand).resolves({
    CiphertextBlob: new TextEncoder().encode("ciphertext"),
  });
  kmsMock.on(DecryptCommand).resolves({
    Plaintext: new TextEncoder().encode(PLAINTEXT_SECRET),
  });
});

afterEach(() => {
  setDocumentClientForTesting(undefined);
  setKmsClientForTesting(undefined);
  delete process.env.SUBSCRIPTIONS_TABLE_NAME;
  delete process.env.SUBSCRIPTIONS_BY_CUSTOMER_INDEX;
  delete process.env.SUBSCRIPTION_SECRET_KEY_ID;
});

afterAll(() => {
  ddbMock.restore();
  kmsMock.restore();
});

describe("getSubscription", () => {
  it("returns 200 with the subscription and a decrypted secret", async () => {
    ddbMock.on(GetCommand).resolves({ Item: storedSubscription() });

    const res = await getSubscription(
      makeContext({ method: "GET", subscriptionId: SUBSCRIPTION_ID }),
    );

    expect(res.statusCode).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.customerId).toBe(CUSTOMER_ID);
    expect(body.secret).toBe(PLAINTEXT_SECRET);
    // The opaque ciphertext is never returned to the caller.
    expect(body).not.toHaveProperty("encryptedSecret");

    const getCall = ddbMock.commandCalls(GetCommand)[0];
    expect(getCall.args[0].input).toMatchObject({
      TableName: TABLE_NAME,
      Key: { subscriptionId: SUBSCRIPTION_ID },
    });
    // Decrypt is bound to the subscriptionId via the encryption context.
    const decryptCall = kmsMock.commandCalls(DecryptCommand)[0];
    expect(decryptCall.args[0].input.EncryptionContext).toEqual({
      subscriptionId: SUBSCRIPTION_ID,
    });
  });

  it("throws 404 when the subscription does not exist", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    await expect(
      getSubscription(
        makeContext({ method: "GET", subscriptionId: SUBSCRIPTION_ID }),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

});

describe("listSubscriptions", () => {
  it("queries the GSI and returns each subscription with a decrypted secret", async () => {
    const other = storedSubscription({
      subscriptionId: "33333333-3333-4333-8333-333333333333",
      eventName: "briefing.trigger",
    });
    ddbMock.on(QueryCommand).resolves({ Items: [storedSubscription(), other] });

    const res = await listSubscriptions(
      makeContext({ method: "GET", customerId: CUSTOMER_ID }),
    );

    expect(res.statusCode).toBe(200);
    const body = res.body as { subscriptions: Record<string, unknown>[] };
    expect(body.subscriptions).toHaveLength(2);
    for (const sub of body.subscriptions) {
      expect(sub.secret).toBe(PLAINTEXT_SECRET);
      expect(sub).not.toHaveProperty("encryptedSecret");
    }

    const queryCall = ddbMock.commandCalls(QueryCommand)[0];
    expect(queryCall.args[0].input).toMatchObject({
      TableName: TABLE_NAME,
      IndexName: INDEX_NAME,
    });
    expect(
      queryCall.args[0].input.ExpressionAttributeValues?.[":customerId"],
    ).toBe(CUSTOMER_ID);
  });

  it("returns an empty list when the customer has no subscriptions", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await listSubscriptions(
      makeContext({ method: "GET", customerId: CUSTOMER_ID }),
    );

    expect(res.body).toEqual({ subscriptions: [] });
  });

  it("throws 400 for a non-UUID customerId", async () => {
    await expect(
      listSubscriptions(makeContext({ method: "GET", customerId: "bad" })),
    ).rejects.toThrow(HttpError);
  });
});

describe("createSubscription", () => {
  it("encrypts the secret before PutItem and never stores plaintext", async () => {
    ddbMock.on(PutCommand).resolves({});

    const res = await createSubscription(
      makeContext({
        method: "POST",
        customerId: CUSTOMER_ID,
        body: createBody(),
      }),
    );

    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ subscriptionId: SUBSCRIPTION_ID });

    // Secret was encrypted with the configured key, bound to the subscriptionId.
    const encryptCall = kmsMock.commandCalls(EncryptCommand)[0];
    expect(encryptCall.args[0].input.KeyId).toBe(KEY_ID);
    expect(encryptCall.args[0].input.EncryptionContext).toEqual({
      subscriptionId: SUBSCRIPTION_ID,
    });

    // The stored item carries encryptedSecret (base64 of the KMS ciphertext
    // blob), not the plaintext secret.
    const putCall = ddbMock.commandCalls(PutCommand)[0];
    const item = putCall.args[0].input.Item as Record<string, unknown>;
    expect(item.encryptedSecret).toBe(CIPHERTEXT);
    expect(item).not.toHaveProperty("secret");
    expect(item.customerId).toBe(CUSTOMER_ID);
  });

  it("returns 400 when the body fails validation", async () => {
    const bad = createBody({ secret: "not-a-whsec-secret" });

    await expect(
      createSubscription(
        makeContext({ method: "POST", customerId: CUSTOMER_ID, body: bad }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("returns 400 when the body customerId does not match the path", async () => {
    const mismatched = createBody({
      customerId: "99999999-9999-4999-8999-999999999999",
    });

    await expect(
      createSubscription(
        makeContext({
          method: "POST",
          customerId: CUSTOMER_ID,
          body: mismatched,
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("putSubscription", () => {
  it("updates supplied fields and returns the decrypted subscription", async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: storedSubscription() });

    const res = await putSubscription(
      makeContext({
        method: "PUT",
        subscriptionId: SUBSCRIPTION_ID,
        body: {
          expiresAt: "2024-03-01T00:00:00.000Z",
          lastRefreshedAt: "2024-02-01T00:00:00.000Z",
        },
      }),
    );

    expect(res.statusCode).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.secret).toBe(PLAINTEXT_SECRET);
    expect(body).not.toHaveProperty("encryptedSecret");

    const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
    const input = updateCall.args[0].input;
    expect(input.Key).toEqual({ subscriptionId: SUBSCRIPTION_ID });
    expect(input.ConditionExpression).toBe("attribute_exists(subscriptionId)");
    // No secret in the update -> no Encrypt call.
    expect(kmsMock.commandCalls(EncryptCommand)).toHaveLength(0);
  });

  it("re-encrypts a rotated secret into encryptedSecret", async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: storedSubscription() });

    await putSubscription(
      makeContext({
        method: "PUT",
        subscriptionId: SUBSCRIPTION_ID,
        body: { secret: PLAINTEXT_SECRET },
      }),
    );

    expect(kmsMock.commandCalls(EncryptCommand)).toHaveLength(1);
    const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
    const values = updateCall.args[0].input.ExpressionAttributeValues ?? {};
    // The rotated secret is stored as ciphertext, never as plaintext.
    expect(Object.values(values)).toContain(CIPHERTEXT);
    expect(Object.values(values)).not.toContain(PLAINTEXT_SECRET);
  });

  it("throws 404 when the subscription does not exist", async () => {
    const conditionalFailure = Object.assign(
      new Error("The conditional request failed"),
      { name: "ConditionalCheckFailedException" },
    );
    ddbMock.on(UpdateCommand).rejects(conditionalFailure);

    await expect(
      putSubscription(
        makeContext({
          method: "PUT",
          subscriptionId: SUBSCRIPTION_ID,
          body: { expiresAt: "2024-03-01T00:00:00.000Z" },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("throws 400 when no updatable fields are supplied", async () => {
    await expect(
      putSubscription(
        makeContext({
          method: "PUT",
          subscriptionId: SUBSCRIPTION_ID,
          body: {},
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
