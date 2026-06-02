/**
 * Integration-style unit tests for the Data API Lambda handler (task 4.1).
 *
 * These drive the real `handler` with synthetic API Gateway proxy events to
 * verify the end-to-end behavior of routing + dual authorization + error
 * mapping:
 * - unknown routes -> 404,
 * - Cognito caller accessing own vs other customerId -> dispatch vs 403,
 * - Cognito caller on a backend-only route -> 403,
 * - IAM caller on any customer / backend route -> dispatch,
 * - missing caller identity -> 403,
 * - malformed JSON body -> 400,
 * - matched-but-unimplemented routes -> 501 (stubs from tasks 4.3-4.6),
 * - OPTIONS preflight -> 204,
 * - CORS headers present on responses.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DecryptCommand, KMSClient } from "@aws-sdk/client-kms";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { handler } from "./handler.js";
import { setDocumentClientForTesting as setConfigDocumentClientForTesting } from "./routes/config.js";
import { setS3ClientForTesting as setReportsS3ClientForTesting } from "./routes/reports.js";
import { setS3ClientForTesting } from "./routes/session.js";
import {
  setDocumentClientForTesting as setSubscriptionsDocumentClientForTesting,
  setKmsClientForTesting as setSubscriptionsKmsClientForTesting,
} from "./routes/subscriptions.js";

const SUB = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SUBSCRIPTION_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ARN = "arn:aws:sts::123456789012:assumed-role/AgentRole/session";

const s3Mock = mockClient(S3Client);
const ddbMock = mockClient(DynamoDBDocumentClient);
const kmsMock = mockClient(KMSClient);

beforeAll(() => {
  process.env.ALLOWED_ORIGIN = "https://app.example.com";
});

afterEach(() => {
  s3Mock.reset();
  ddbMock.reset();
  kmsMock.reset();
  setS3ClientForTesting(undefined);
  setReportsS3ClientForTesting(undefined);
  setConfigDocumentClientForTesting(undefined);
  setSubscriptionsDocumentClientForTesting(undefined);
  setSubscriptionsKmsClientForTesting(undefined);
  delete process.env.SESSIONS_BUCKET_NAME;
  delete process.env.REPORTS_BUCKET_NAME;
  delete process.env.SUBSCRIPTIONS_TABLE_NAME;
  delete process.env.SUBSCRIPTION_SECRET_KEY_ID;
  delete process.env.CUSTOMER_CONFIG_TABLE_NAME;
});

interface EventOptions {
  method: string;
  path: string;
  cognitoSub?: string;
  iamArn?: string;
  body?: string;
  isBase64Encoded?: boolean;
  query?: Record<string, string>;
  origin?: string;
}

function makeEvent(opts: EventOptions): APIGatewayProxyEvent {
  const requestContext: Record<string, unknown> = {};
  if (opts.cognitoSub !== undefined) {
    requestContext.authorizer = { claims: { sub: opts.cognitoSub } };
  } else if (opts.iamArn !== undefined) {
    requestContext.authorizer = null;
    requestContext.identity = { userArn: opts.iamArn };
  } else {
    requestContext.authorizer = null;
    requestContext.identity = {};
  }

  return {
    httpMethod: opts.method,
    path: opts.path,
    body: opts.body ?? null,
    isBase64Encoded: opts.isBase64Encoded ?? false,
    queryStringParameters: opts.query ?? null,
    headers: opts.origin === undefined ? {} : { origin: opts.origin },
    requestContext,
  } as unknown as APIGatewayProxyEvent;
}

describe("Data API handler — routing", () => {
  it("returns 404 for an unknown route", async () => {
    const res = await handler(
      makeEvent({ method: "GET", path: "/nope", cognitoSub: SUB }),
    );
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for a known path with an unsupported method", async () => {
    const res = await handler(
      makeEvent({
        method: "PATCH",
        path: `/customers/${SUB}/config`,
        cognitoSub: SUB,
      }),
    );
    expect(res.statusCode).toBe(404);
  });

  it("dispatches a matched route to its handler for the owner", async () => {
    // The session messages route is implemented (task 4.6): a matched +
    // authorized request reaches the handler, which reads the (mocked) S3
    // snapshot and returns the conversation history.
    process.env.SESSIONS_BUCKET_NAME = "test-sessions-bucket";
    setS3ClientForTesting(new S3Client({}));
    s3Mock.on(GetObjectCommand).resolves({
      Body: {
        transformToString: () =>
          Promise.resolve(JSON.stringify({ messages: [] })),
      },
    } as never);

    const res = await handler(
      makeEvent({
        method: "GET",
        path: `/customers/${SUB}/session/messages`,
        cognitoSub: SUB,
      }),
    );
    // Route matched + authorized + dispatched.
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ messages: [] });
  });
});

describe("Data API handler — Cognito authorization", () => {
  it("allows a Cognito caller to reach their own customer resource", async () => {
    // The reports list route is implemented (task 4.4): a matched + authorized
    // request reaches the handler, which lists the (mocked, empty) S3 prefix.
    process.env.REPORTS_BUCKET_NAME = "test-reports-bucket";
    setReportsS3ClientForTesting(new S3Client({}));
    s3Mock
      .on(ListObjectsV2Command)
      .resolves({ Contents: [], IsTruncated: false });

    const res = await handler(
      makeEvent({
        method: "GET",
        path: `/customers/${SUB}/reports`,
        cognitoSub: SUB,
      }),
    );
    expect(res.statusCode).toBe(200); // matched + authorized + dispatched
    expect(JSON.parse(res.body)).toEqual({ reports: [] });
  });

  it("rejects a Cognito caller targeting another customerId with 403", async () => {
    const res = await handler(
      makeEvent({
        method: "GET",
        path: `/customers/${OTHER}/config`,
        cognitoSub: SUB,
      }),
    );
    expect(res.statusCode).toBe(403);
  });

  it("rejects a Cognito caller on a backend-only route with 403", async () => {
    const res = await handler(
      makeEvent({
        method: "GET",
        path: "/subscriptions/sub-123",
        cognitoSub: SUB,
      }),
    );
    expect(res.statusCode).toBe(403);
  });
});

describe("Data API handler — IAM authorization", () => {
  it("allows an IAM caller to access any customer", async () => {
    // The reports list route is implemented (task 4.4); an IAM caller may reach
    // any customer's resources.
    process.env.REPORTS_BUCKET_NAME = "test-reports-bucket";
    setReportsS3ClientForTesting(new S3Client({}));
    s3Mock
      .on(ListObjectsV2Command)
      .resolves({ Contents: [], IsTruncated: false });

    const res = await handler(
      makeEvent({
        method: "GET",
        path: `/customers/${OTHER}/reports`,
        iamArn: AGENT_ARN,
      }),
    );
    expect(res.statusCode).toBe(200); // matched + authorized + dispatched
    expect(JSON.parse(res.body)).toEqual({ reports: [] });
  });

  it("allows an IAM caller on backend-only subscription lookup", async () => {
    // The subscription lookup route is implemented (task 4.4): a matched +
    // authorized IAM request resolves the subscription and returns it with the
    // decrypted secret.
    process.env.SUBSCRIPTIONS_TABLE_NAME = "test-subscriptions";
    setSubscriptionsDocumentClientForTesting(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
    );
    setSubscriptionsKmsClientForTesting(new KMSClient({}));
    ddbMock.on(GetCommand).resolves({
      Item: {
        subscriptionId: SUBSCRIPTION_ID,
        customerId: SUB,
        serverEndpoint: "https://usgs-mcp.example.com",
        eventName: "earthquake.detected",
        callbackUrl: "https://webhook.example.com/webhook",
        encryptedSecret: "Y2lwaGVydGV4dA==",
        createdAt: "2024-01-01T00:00:00.000Z",
        expiresAt: "2024-02-01T00:00:00.000Z",
        lastRefreshedAt: "2024-01-01T00:00:00.000Z",
        status: "active",
      },
    });
    kmsMock.on(DecryptCommand).resolves({
      Plaintext: new TextEncoder().encode("whsec_secret"),
    });

    const res = await handler(
      makeEvent({
        method: "GET",
        path: `/subscriptions/${SUBSCRIPTION_ID}`,
        iamArn: AGENT_ARN,
      }),
    );
    expect(res.statusCode).toBe(200); // matched + authorized + dispatched
    expect(JSON.parse(res.body)).toMatchObject({ customerId: SUB });
  });
  it("allows an IAM caller to read any customer's config via the backend path", async () => {
    // The backend config path (/backend/customers/:customerId/config) is
    // declared with IAM auth in the CDK stack and reuses the config GET
    // handler. A backend (agent) caller may read any customer's config
    // (Requirement 9.3); the webapp path stays Cognito-only.
    process.env.CUSTOMER_CONFIG_TABLE_NAME = "test-customer-config";
    setConfigDocumentClientForTesting(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
    );
    const stored = {
      customerId: OTHER,
      displayName: "Acme Seismology",
      subscriptionParams: { minMagnitude: 4.5, region: "pacific" },
      briefingPrompt: "Summarize notable earthquakes for the Pacific region.",
      briefingSchedule: "0 8 * * 1",
      active: true,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    ddbMock.on(GetCommand).resolves({ Item: stored });

    const res = await handler(
      makeEvent({
        method: "GET",
        path: `/backend/customers/${OTHER}/config`,
        iamArn: AGENT_ARN,
      }),
    );
    expect(res.statusCode).toBe(200); // matched + authorized + dispatched
    expect(JSON.parse(res.body)).toMatchObject({ customerId: OTHER });
  });

  it("rejects a Cognito caller targeting another customer on the backend config path with 403", async () => {
    // At the API Gateway layer this backend path is IAM-only, so a Cognito JWT
    // bearer never reaches the Lambda. At the Lambda layer the route is still
    // customerScoped, so a cross-customer access attempt is rejected by
    // enforceCustomerAccess with 403 (Requirements 5.3, 9.2).
    const res = await handler(
      makeEvent({
        method: "GET",
        path: `/backend/customers/${OTHER}/config`,
        cognitoSub: SUB,
      }),
    );
    expect(res.statusCode).toBe(403);
  });
});

describe("Data API handler — error handling", () => {
  it("returns 403 when no caller identity is present", async () => {
    const res = await handler(
      makeEvent({ method: "GET", path: `/customers/${SUB}/config` }),
    );
    expect(res.statusCode).toBe(403);
  });

  it("returns 400 for a malformed JSON body on an authorized route", async () => {
    const res = await handler(
      makeEvent({
        method: "PUT",
        path: `/customers/${SUB}/config`,
        cognitoSub: SUB,
        body: "{ not json",
      }),
    );
    expect(res.statusCode).toBe(400);
  });

  it("responds 204 to an OPTIONS preflight", async () => {
    const res = await handler(
      makeEvent({ method: "OPTIONS", path: `/customers/${SUB}/config` }),
    );
    expect(res.statusCode).toBe(204);
  });
});

describe("Data API handler — response shape", () => {
  it("includes CORS headers on responses", async () => {
    const res = await handler(
      makeEvent({ method: "GET", path: "/nope", cognitoSub: SUB }),
    );
    expect(res.headers?.["Access-Control-Allow-Origin"]).toBe(
      "https://app.example.com",
    );
    expect(res.headers?.["Access-Control-Allow-Credentials"]).toBe("true");
  });

  it("reflects an allowlisted localhost origin when configured", async () => {
    process.env.ALLOWED_ORIGIN =
      "https://app.example.com,http://localhost:5173";
    try {
      const res = await handler(
        makeEvent({
          method: "GET",
          path: "/nope",
          cognitoSub: SUB,
          origin: "http://localhost:5173",
        }),
      );
      expect(res.headers?.["Access-Control-Allow-Origin"]).toBe(
        "http://localhost:5173",
      );
      expect(res.headers?.Vary).toBe("Origin");
    } finally {
      process.env.ALLOWED_ORIGIN = "https://app.example.com";
    }
  });

  it("does not reflect a disallowed origin (falls back to the primary origin)", async () => {
    const res = await handler(
      makeEvent({
        method: "GET",
        path: "/nope",
        cognitoSub: SUB,
        origin: "https://evil.example.com",
      }),
    );
    expect(res.headers?.["Access-Control-Allow-Origin"]).toBe(
      "https://app.example.com",
    );
  });

  it("returns a JSON error body for 403 responses", async () => {
    const res = await handler(
      makeEvent({
        method: "GET",
        path: `/customers/${OTHER}/config`,
        cognitoSub: SUB,
      }),
    );
    expect(res.statusCode).toBe(403);
    const parsed = JSON.parse(res.body) as { error: string };
    expect(typeof parsed.error).toBe("string");
  });
});
