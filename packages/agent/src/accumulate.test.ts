/**
 * Unit tests for the earthquake event processing logic (task 9.4).
 *
 * These tests run the REAL Strands {@link Agent} + {@link SessionManager} +
 * the SDK's {@link S3Storage} against:
 * - a mocked S3 client (`aws-sdk-client-mock`) standing in for the sessions
 *   bucket, and
 * - a {@link FakeModel} test double swapped in via {@link setModelForTesting}
 *   so no real Bedrock call is made.
 *
 * This exercises the genuine restore -> idempotency -> inject -> invoke ->
 * persist path without AWS or LLM access (Requirements 4.4, 7.1, 7.2):
 * - injects the earthquake as a user message and records the assistant's
 *   analysis (the conversation history grows),
 * - persists the updated conversation history + metadata to the SDK snapshot
 *   key `sessions/{customerId}/scopes/agent/agent/snapshots/snapshot_latest.json`,
 * - skips a duplicate event whose `eventId` is already in session metadata
 *   (idempotency), without writing a second user message,
 * - restores prior conversation history from an existing session snapshot.
 */

import {
  GetObjectCommand,
  type GetObjectCommandOutput,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type {
  CustomerConfig,
  EarthquakeDetectedData,
  McpEventPayload,
} from "@mcp-events/shared";
import {
  Model,
  type Message,
  type ModelStreamEvent,
  type Snapshot,
  type StreamOptions,
} from "@strands-agents/sdk";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PROCESSED_EVENT_IDS_LIMIT,
  SESSION_METADATA_KEY,
  formatEarthquakeUserMessage,
  processEarthquakeEvent,
  setModelForTesting,
  setS3ClientForTesting,
  type SessionMetadata,
} from "./accumulate.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BUCKET_NAME = "test-sessions-bucket";
const CUSTOMER_ID = "33333333-3333-4333-8333-333333333333";
const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ANALYSIS_TEXT = "This is a moderate earthquake with no tsunami risk.";

const s3Mock = mockClient(S3Client);

/** A minimal CustomerConfig for the test customer. */
function makeConfig(overrides: Partial<CustomerConfig> = {}): CustomerConfig {
  return {
    customerId: CUSTOMER_ID,
    displayName: "Test Customer",
    subscriptionParams: { minMagnitude: 2.5 },
    briefingPrompt: "You are a seismologist. Analyze earthquakes concisely.",
    briefingSchedule: 24,
    active: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A valid `earthquake.detected` MCP event payload. */
function makeEvent(
  eventId = EVENT_ID,
  data: Partial<EarthquakeDetectedData> = {},
): McpEventPayload<EarthquakeDetectedData> {
  return {
    eventId,
    name: "earthquake.detected",
    timestamp: "2024-01-01T00:00:00.000Z",
    data: {
      earthquakeId: "us7000n123",
      magnitude: 5.2,
      place: "10km SW of Ridgecrest, CA",
      coordinates: { longitude: -117.5, latitude: 35.6, depth: 8.2 },
      time: "2024-01-01T00:00:00.000Z",
      tsunami: false,
      felt: 12,
      alert: "green",
      url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000n123",
      ...data,
    },
    cursor: "cursor-1",
  };
}

// ---------------------------------------------------------------------------
// Fake model
// ---------------------------------------------------------------------------

/**
 * A deterministic stand-in for a Bedrock model. It ignores the input messages
 * and streams a single fixed text response, which is enough for the agent loop
 * to append an assistant message and stop (`stopReason: 'endTurn'`).
 */
class FakeModel extends Model {
  /** Records the messages the agent sent to the model on each call. */
  public readonly calls: Message[][] = [];

  constructor(private readonly text: string = ANALYSIS_TEXT) {
    super();
  }

  updateConfig(): void {
    // no-op for the fake
  }

  getConfig(): { modelId: string } {
    return { modelId: "fake-model" };
  }

  async *stream(
    messages: Message[],
    _options?: StreamOptions,
  ): AsyncIterable<ModelStreamEvent> {
    this.calls.push(messages);
    yield { type: "modelMessageStartEvent", role: "assistant" };
    yield { type: "modelContentBlockStartEvent" };
    yield {
      type: "modelContentBlockDeltaEvent",
      delta: { type: "textDelta", text: this.text },
    };
    yield { type: "modelContentBlockStopEvent" };
    yield { type: "modelMessageStopEvent", stopReason: "endTurn" };
  }
}

// ---------------------------------------------------------------------------
// S3 mock helpers
// ---------------------------------------------------------------------------

/** Wrap a JSON string as a mocked S3 streaming body. */
function streamBody(text: string): GetObjectCommandOutput["Body"] {
  return {
    transformToString: async () => text,
  } as unknown as GetObjectCommandOutput["Body"];
}

/** The S3 key for the customer's session snapshot (SDK latest-snapshot key). */
function sessionKey(): string {
  return `sessions/${CUSTOMER_ID}/scopes/agent/agent/snapshots/snapshot_latest.json`;
}

/**
 * Build a Strands SDK `Snapshot` carrying the given prior messages and session
 * metadata, matching what the SDK's {@link S3Storage} persists.
 */
function makeSnapshot(opts: {
  messages?: { role: "user" | "assistant"; text: string }[];
  metadata?: Partial<SessionMetadata>;
}): Snapshot {
  const messages = (opts.messages ?? []).map((m) => ({
    role: m.role,
    content: [{ text: m.text }],
  }));
  const state: Record<string, unknown> = {};
  if (opts.metadata) {
    state[SESSION_METADATA_KEY] = {
      lastEventId: "",
      lastActiveAt: "",
      invocationCount: 0,
      lastBriefingAt: null,
      customerDisplayName: "Test Customer",
      processedEventIds: [],
      ...opts.metadata,
    };
  }
  return {
    scope: "agent",
    schemaVersion: "1.0",
    createdAt: "2024-01-01T00:00:00.000Z",
    data: { messages, state },
    appData: {},
  } as unknown as Snapshot;
}

/**
 * Parse the body of the Nth PutObject call that targeted the session key.
 * Returns the persisted snapshot, or undefined if no such call was made.
 */
function persistedSnapshot(): Snapshot | undefined {
  const calls = s3Mock
    .commandCalls(PutObjectCommand)
    .filter((call) => call.args[0].input.Key === sessionKey());
  const last = calls.at(-1);
  if (!last) {
    return undefined;
  }
  return JSON.parse(last.args[0].input.Body as string) as Snapshot;
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  s3Mock.reset();
  setS3ClientForTesting(s3Mock as unknown as S3Client);
  // List/manifest calls default to "nothing there" unless a test overrides.
  s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
  s3Mock.on(PutObjectCommand).resolves({});
  process.env.SESSIONS_BUCKET_NAME = BUCKET_NAME;
});

afterEach(() => {
  setS3ClientForTesting(undefined);
  setModelForTesting(undefined);
  delete process.env.SESSIONS_BUCKET_NAME;
});

afterAll(() => {
  s3Mock.restore();
});

// ---------------------------------------------------------------------------
// formatEarthquakeUserMessage
// ---------------------------------------------------------------------------

describe("formatEarthquakeUserMessage", () => {
  it("includes the earthquake's salient facts", () => {
    const message = formatEarthquakeUserMessage(makeEvent().data);
    expect(message).toContain("us7000n123");
    expect(message).toContain("5.2");
    expect(message).toContain("10km SW of Ridgecrest, CA");
    expect(message).toContain("8.2 km");
  });

  it("renders a null felt count as 'no reports'", () => {
    const message = formatEarthquakeUserMessage(
      makeEvent(EVENT_ID, { felt: null }).data,
    );
    expect(message).toContain("no reports");
  });

  it("renders a null alert level as 'none'", () => {
    const message = formatEarthquakeUserMessage(
      makeEvent(EVENT_ID, { alert: null }).data,
    );
    expect(message).toContain("PAGER alert level: none");
  });
});

// ---------------------------------------------------------------------------
// processEarthquakeEvent — happy path
// ---------------------------------------------------------------------------

describe("processEarthquakeEvent", () => {
  it("injects the earthquake, invokes the LLM, and persists the session (no prior session)", async () => {
    const model = new FakeModel();
    setModelForTesting(model);
    // No prior session: GetObject for the snapshot returns NoSuchKey.
    s3Mock
      .on(GetObjectCommand, { Key: sessionKey() })
      .rejects(Object.assign(new Error("missing"), { name: "NoSuchKey" }));

    const result = await processEarthquakeEvent({
      customerId: CUSTOMER_ID,
      config: makeConfig(),
      event: makeEvent(),
    });

    expect(result).toMatchObject({
      status: "processed",
      customerId: CUSTOMER_ID,
      eventId: EVENT_ID,
      analysis: ANALYSIS_TEXT,
    });

    // The model was invoked exactly once, and the messages it received carry
    // the earthquake facts in a user message. (The agent mutates the messages
    // array in place, so by assertion time it also holds the assistant reply.)
    expect(model.calls).toHaveLength(1);
    const sentMessages = model.calls[0];
    const userMessage = sentMessages.find((m) => m.role === "user");
    expect(JSON.stringify(userMessage)).toContain("us7000n123");

    // The session was persisted to the SDK snapshot_latest.json key with the
    // user message + assistant analysis in conversation history.
    const snapshot = persistedSnapshot();
    expect(snapshot).toBeDefined();
    const data = snapshot!.data as unknown as {
      messages: { role: string; content: { text?: string }[] }[];
      state: Record<string, SessionMetadata>;
    };
    expect(data.messages).toHaveLength(2);
    expect(data.messages[0].role).toBe("user");
    expect(data.messages[1].role).toBe("assistant");
    expect(JSON.stringify(data.messages[1])).toContain(ANALYSIS_TEXT);

    // Idempotency metadata records the processed event.
    const metadata = data.state[SESSION_METADATA_KEY];
    expect(metadata.processedEventIds).toContain(EVENT_ID);
    expect(metadata.lastEventId).toBe(EVENT_ID);
    expect(metadata.invocationCount).toBe(1);
  });

  it("restores prior conversation history and appends the new exchange", async () => {
    setModelForTesting(new FakeModel());
    s3Mock.on(GetObjectCommand, { Key: sessionKey() }).resolves({
      Body: streamBody(
        JSON.stringify(
          makeSnapshot({
            messages: [
              {
                role: "user",
                text: "A new earthquake has been detected: M4.0",
              },
              { role: "assistant", text: "Minor quake, no action needed." },
            ],
            metadata: {
              processedEventIds: ["00000000-0000-4000-8000-000000000000"],
              invocationCount: 1,
            },
          }),
        ),
      ),
    });

    await processEarthquakeEvent({
      customerId: CUSTOMER_ID,
      config: makeConfig(),
      event: makeEvent(),
    });

    const snapshot = persistedSnapshot();
    const data = snapshot!.data as unknown as {
      messages: { role: string }[];
      state: Record<string, SessionMetadata>;
    };
    // 2 prior + 1 new user + 1 new assistant = 4.
    expect(data.messages).toHaveLength(4);
    const metadata = data.state[SESSION_METADATA_KEY];
    expect(metadata.invocationCount).toBe(2);
    expect(metadata.processedEventIds).toContain(EVENT_ID);
    expect(metadata.processedEventIds).toContain(
      "00000000-0000-4000-8000-000000000000",
    );
  });

  // -------------------------------------------------------------------------
  // Idempotency (Requirements 7.1, 7.2)
  // -------------------------------------------------------------------------

  it("skips a duplicate event already in session metadata without re-invoking the LLM", async () => {
    const model = new FakeModel();
    setModelForTesting(model);
    s3Mock.on(GetObjectCommand, { Key: sessionKey() }).resolves({
      Body: streamBody(
        JSON.stringify(
          makeSnapshot({
            messages: [
              { role: "user", text: "A new earthquake has been detected: ..." },
              { role: "assistant", text: "Prior analysis." },
            ],
            metadata: {
              processedEventIds: [EVENT_ID],
              lastEventId: EVENT_ID,
              invocationCount: 1,
            },
          }),
        ),
      ),
    });

    const result = await processEarthquakeEvent({
      customerId: CUSTOMER_ID,
      config: makeConfig(),
      event: makeEvent(),
    });

    expect(result).toEqual({
      status: "skipped",
      customerId: CUSTOMER_ID,
      eventId: EVENT_ID,
    });
    // The LLM was never invoked for the duplicate.
    expect(model.calls).toHaveLength(0);
    // No second user message was written to the session.
    expect(persistedSnapshot()).toBeUndefined();
  });

  it("does not add a duplicate user message when the same event is delivered twice", async () => {
    setModelForTesting(new FakeModel());
    // First delivery: no prior session.
    s3Mock
      .on(GetObjectCommand, { Key: sessionKey() })
      .rejects(Object.assign(new Error("missing"), { name: "NoSuchKey" }));

    await processEarthquakeEvent({
      customerId: CUSTOMER_ID,
      config: makeConfig(),
      event: makeEvent(),
    });

    const afterFirst = persistedSnapshot();
    expect(afterFirst).toBeDefined();

    // Second delivery: the session now contains the first exchange and the
    // processed event id, so the GetObject returns that persisted snapshot.
    s3Mock
      .on(GetObjectCommand, { Key: sessionKey() })
      .resolves({ Body: streamBody(JSON.stringify(afterFirst)) });
    s3Mock.resetHistory();

    const second = await processEarthquakeEvent({
      customerId: CUSTOMER_ID,
      config: makeConfig(),
      event: makeEvent(),
    });

    expect(second.status).toBe("skipped");
    // No new session write occurred on the duplicate delivery.
    expect(persistedSnapshot()).toBeUndefined();
  });

  it("uses the customer's briefingPrompt as the system prompt on the model call", async () => {
    const model = new FakeModel();
    setModelForTesting(model);
    s3Mock
      .on(GetObjectCommand, { Key: sessionKey() })
      .rejects(Object.assign(new Error("missing"), { name: "NoSuchKey" }));

    const config = makeConfig({
      briefingPrompt: "CUSTOM-PROMPT marker for assertion",
    });
    await processEarthquakeEvent({
      customerId: CUSTOMER_ID,
      config,
      event: makeEvent(),
    });

    const snapshot = persistedSnapshot();
    const data = snapshot!.data as unknown as { systemPrompt?: unknown };
    expect(JSON.stringify(data.systemPrompt)).toContain(
      "CUSTOM-PROMPT marker for assertion",
    );
  });

  it("propagates an LLM failure without persisting (lets SQS retry)", async () => {
    class FailingModel extends Model {
      updateConfig(): void {
        // no-op for the fake
      }
      getConfig(): { modelId: string } {
        return { modelId: "failing" };
      }
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<ModelStreamEvent> {
        throw new Error("model unavailable");
      }
    }
    setModelForTesting(new FailingModel());
    s3Mock
      .on(GetObjectCommand, { Key: sessionKey() })
      .rejects(Object.assign(new Error("missing"), { name: "NoSuchKey" }));

    await expect(
      processEarthquakeEvent({
        customerId: CUSTOMER_ID,
        config: makeConfig(),
        event: makeEvent(),
      }),
    ).rejects.toThrow();

    // Nothing was persisted to the session key, so a retry can reprocess.
    expect(persistedSnapshot()).toBeUndefined();
  });

  it("bounds the processed event id window to PROCESSED_EVENT_IDS_LIMIT", async () => {
    setModelForTesting(new FakeModel());
    // Seed a session whose window is already at the limit.
    const seeded = Array.from(
      { length: PROCESSED_EVENT_IDS_LIMIT },
      (_v, i) => `seed-${i}`,
    );
    s3Mock.on(GetObjectCommand, { Key: sessionKey() }).resolves({
      Body: streamBody(
        JSON.stringify(
          makeSnapshot({
            metadata: {
              processedEventIds: seeded,
              invocationCount: seeded.length,
            },
          }),
        ),
      ),
    });

    await processEarthquakeEvent({
      customerId: CUSTOMER_ID,
      config: makeConfig(),
      event: makeEvent(),
    });

    const snapshot = persistedSnapshot();
    const data = snapshot!.data as unknown as {
      state: Record<string, SessionMetadata>;
    };
    const metadata = data.state[SESSION_METADATA_KEY];
    expect(metadata.processedEventIds).toHaveLength(PROCESSED_EVENT_IDS_LIMIT);
    // The newest event is retained; the oldest was evicted.
    expect(metadata.processedEventIds).toContain(EVENT_ID);
    expect(metadata.processedEventIds).not.toContain("seed-0");
  });
});
