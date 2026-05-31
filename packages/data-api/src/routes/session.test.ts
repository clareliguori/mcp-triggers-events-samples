/**
 * Unit tests for the read-only session messages route handler (task 4.6).
 *
 * The S3 client is mocked with `aws-sdk-client-mock` so the tests exercise the
 * real handler logic (key construction, snapshot parsing, graceful fallbacks)
 * without touching AWS. The `GetObject` response `Body` is stubbed with a
 * minimal object exposing `transformToString()` — the only method the handler
 * uses — which avoids depending on the streaming-blob helpers.
 *
 * Covered:
 * - session found (top-level `messages`) -> returns that array,
 * - session found (Strands SDK snapshot with nested `data.messages`) -> returns
 *   the nested array,
 * - session missing (`NoSuchKey`) -> 200 with empty messages,
 * - 404 `$metadata` status -> 200 with empty messages,
 * - malformed JSON -> 200 with empty messages,
 * - correct S3 bucket + key
 *   (`sessions/{customerId}/scopes/agent/agent/snapshots/snapshot_latest.json`),
 * - non-UUID customerId -> 400.
 */

import {
  GetObjectCommand,
  NoSuchKey,
  S3Client,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { getSessionMessages, setS3ClientForTesting } from "./session.js";
import { HttpError } from "../http.js";
import type { AuthContext, RouteContext } from "../types.js";

const BUCKET_NAME = "test-sessions-bucket";
const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";

const s3Mock = mockClient(S3Client);

/**
 * Build a `GetObject` response whose `Body` exposes `transformToString()`
 * returning `content`. Cast to the SDK output type since only that one method
 * is exercised by the handler.
 */
function bodyResponse(content: string): GetObjectCommandOutput {
  return {
    Body: {
      transformToString: () => Promise.resolve(content),
    },
  } as unknown as GetObjectCommandOutput;
}

/** Build a RouteContext for the session messages route. */
function makeContext(opts: { customerId?: string } = {}): RouteContext {
  const auth: AuthContext = {
    authType: "cognito",
    cognitoSub: opts.customerId ?? CUSTOMER_ID,
  };
  return {
    event: {} as RouteContext["event"],
    method: "GET",
    pathParameters: { customerId: opts.customerId ?? CUSTOMER_ID },
    query: {},
    body: undefined,
    auth,
  };
}

beforeEach(() => {
  s3Mock.reset();
  setS3ClientForTesting(new S3Client({}));
  process.env.SESSIONS_BUCKET_NAME = BUCKET_NAME;
});

afterEach(() => {
  setS3ClientForTesting(undefined);
  delete process.env.SESSIONS_BUCKET_NAME;
});

afterAll(() => {
  s3Mock.restore();
});

describe("getSessionMessages", () => {
  it("returns the messages array from an AgentSessionState snapshot", async () => {
    const messages = [
      { role: "user", content: "M5.2 earthquake near X", timestamp: "t1" },
      { role: "assistant", content: "Analysis ...", timestamp: "t2" },
    ];
    s3Mock.on(GetObjectCommand).resolves(
      bodyResponse(
        JSON.stringify({
          sessionId: CUSTOMER_ID,
          customerId: CUSTOMER_ID,
          messages,
          metadata: {},
        }),
      ),
    );

    const res = await getSessionMessages(makeContext());

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ messages });
  });

  it("reads the SDK snapshot_latest.json key from the sessions bucket", async () => {
    s3Mock
      .on(GetObjectCommand)
      .resolves(bodyResponse(JSON.stringify({ messages: [] })));

    await getSessionMessages(makeContext());

    const call = s3Mock.commandCalls(GetObjectCommand)[0];
    expect(call.args[0].input).toEqual({
      Bucket: BUCKET_NAME,
      Key: `sessions/${CUSTOMER_ID}/scopes/agent/agent/snapshots/snapshot_latest.json`,
    });
  });

  it("extracts nested data.messages from a Strands SDK snapshot", async () => {
    const messages = [
      { role: "user", content: "quake", timestamp: "t1" },
      { role: "tool", content: [{ type: "tool_use" }], timestamp: "t2" },
    ];
    s3Mock.on(GetObjectCommand).resolves(
      bodyResponse(
        JSON.stringify({
          scope: "agent",
          schemaVersion: "1.0",
          createdAt: "2024-01-01T00:00:00.000Z",
          data: { messages, state: {} },
          appData: {},
        }),
      ),
    );

    const res = await getSessionMessages(makeContext());

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ messages });
  });

  it("returns empty messages when the session object is missing (NoSuchKey)", async () => {
    s3Mock.on(GetObjectCommand).rejects(
      new NoSuchKey({
        message: "The specified key does not exist.",
        $metadata: { httpStatusCode: 404 },
      }),
    );

    const res = await getSessionMessages(makeContext());

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ messages: [] });
  });

  it("returns empty messages on a 404 without a typed error name", async () => {
    s3Mock.on(GetObjectCommand).rejects(
      Object.assign(new Error("not found"), {
        $metadata: { httpStatusCode: 404 },
      }),
    );

    const res = await getSessionMessages(makeContext());

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ messages: [] });
  });

  it("returns empty messages when the snapshot is malformed JSON", async () => {
    s3Mock.on(GetObjectCommand).resolves(bodyResponse("{ not valid json"));

    const res = await getSessionMessages(makeContext());

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ messages: [] });
  });

  it("returns empty messages when the snapshot has no messages array", async () => {
    s3Mock
      .on(GetObjectCommand)
      .resolves(bodyResponse(JSON.stringify({ data: { state: {} } })));

    const res = await getSessionMessages(makeContext());

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ messages: [] });
  });

  it("returns empty messages when the body is empty", async () => {
    s3Mock.on(GetObjectCommand).resolves(bodyResponse(""));

    const res = await getSessionMessages(makeContext());

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ messages: [] });
  });

  it("throws 400 for a non-UUID customerId", async () => {
    await expect(
      getSessionMessages(makeContext({ customerId: "not-a-uuid" })),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      getSessionMessages(makeContext({ customerId: "not-a-uuid" })),
    ).rejects.toThrow(HttpError);
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
  });

  it("propagates unexpected S3 errors (non-404) as thrown errors", async () => {
    s3Mock.on(GetObjectCommand).rejects(
      Object.assign(new Error("access denied"), {
        name: "AccessDenied",
        $metadata: { httpStatusCode: 403 },
      }),
    );

    await expect(getSessionMessages(makeContext())).rejects.toThrow(
      "access denied",
    );
  });
});
