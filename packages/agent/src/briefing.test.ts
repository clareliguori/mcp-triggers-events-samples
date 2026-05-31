/**
 * Unit tests for the briefing trigger processing logic (task 9.8).
 *
 * These tests run the REAL Strands {@link Agent} + {@link SessionManager} +
 * the SDK's {@link S3Storage} against:
 * - a mocked S3 client (`aws-sdk-client-mock`) standing in for the sessions
 *   bucket,
 * - a {@link ToolCallingModel} test double swapped in via
 *   {@link setModelForTesting} that simulates the LLM calling the `save_report`
 *   tool with narrative fields, and
 * - a mocked Data API report writer swapped in via
 *   {@link setReportWriterForTesting} so no SigV4 / network call is made.
 *
 * This exercises the genuine restore -> guard -> inject -> invoke ->
 * save_report -> persist path without AWS or LLM access (Requirements 4.5, 4.6,
 * 11.1-11.6, 7.1, 7.3):
 * - synthesizes a report from the conversation history, the host owns the
 *   deterministic fields (period bounds, totals, ids) and POSTs the full report
 *   to the Data API,
 * - clears the conversation and stamps `lastBriefingAt` on the persisted
 *   session,
 * - skips a duplicate trigger (idempotency) without invoking the LLM,
 * - skips when there are no earthquake observations (no empty report),
 * - throws (for SQS retry) when the Data API write fails, persisting nothing.
 */

import {
  GetObjectCommand,
  type GetObjectCommandOutput,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type {
  BriefingReport,
  BriefingTriggerData,
  CustomerConfig,
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
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  EARTHQUAKE_MESSAGE_PREFIX,
  SESSION_METADATA_KEY,
  type SessionMetadata,
  setModelForTesting,
  setS3ClientForTesting,
} from "./accumulate.js";
import {
  BRIEFING_TRIGGER_MESSAGE,
  processBriefingEvent,
  setReportWriterForTesting,
  type ReportWriteResult,
} from "./briefing.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BUCKET_NAME = "test-sessions-bucket";
const CUSTOMER_ID = "33333333-3333-4333-8333-333333333333";
const BRIEFING_EVENT_ID = "44444444-4444-4444-8444-444444444444";

const s3Mock = mockClient(S3Client);

/** A minimal CustomerConfig for the test customer. */
function makeConfig(overrides: Partial<CustomerConfig> = {}): CustomerConfig {
  return {
    customerId: CUSTOMER_ID,
    displayName: "Test Customer",
    subscriptionParams: { minMagnitude: 2.5 },
    briefingPrompt: "You are a seismologist. Summarize earthquakes concisely.",
    briefingSchedule: "0 9 * * *",
    active: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A valid `briefing.trigger` MCP event payload. */
function makeEvent(
  eventId = BRIEFING_EVENT_ID,
): McpEventPayload<BriefingTriggerData> {
  return {
    eventId,
    name: "briefing.trigger",
    timestamp: "2024-02-01T09:00:00.000Z",
    data: {
      triggerType: "scheduled",
      customerId: CUSTOMER_ID,
      scheduledTime: "2024-02-01T09:00:00.000Z",
    },
    cursor: "cursor-briefing",
  };
}

/** Narrative fields the fake model supplies to the save_report tool. */
const SAVE_REPORT_INPUT = {
  summary: "Two moderate earthquakes struck the region this period.",
  notableQuakes: [
    {
      earthquakeId: "us7000n123",
      magnitude: 5.2,
      place: "10km SW of Ridgecrest, CA",
      reason: "Largest of the period.",
    },
  ],
  geographicPatterns: "Clustered along the Eastern California Shear Zone.",
  comparisonToPrevious: "Slightly more active than the previous period.",
};

// ---------------------------------------------------------------------------
// Fake models
// ---------------------------------------------------------------------------

/**
 * A deterministic stand-in for a Bedrock model that simulates an LLM calling
 * the `save_report` tool. On its first invocation it streams a tool-use block
 * for `save_report` (so the agent executes the tool); on the next invocation
 * (after the tool result is appended) it streams a short text response and
 * ends the turn.
 */
class ToolCallingModel extends Model {
  public callCount = 0;
  public readonly calls: Message[][] = [];

  constructor(
    private readonly toolInput: unknown = SAVE_REPORT_INPUT,
    private readonly toolName = "save_report",
  ) {
    super();
  }

  updateConfig(): void {
    // no-op for the fake
  }

  getConfig(): { modelId: string } {
    return { modelId: "fake-tool-model" };
  }

  async *stream(
    messages: Message[],
    _options?: StreamOptions,
  ): AsyncIterable<ModelStreamEvent> {
    // Record a shallow copy: the agent mutates (and the briefing path later
    // clears) its messages array in place, so a reference would not reflect
    // the state at call time.
    this.calls.push([...messages]);
    this.callCount += 1;
    if (this.callCount === 1) {
      // First turn: request the save_report tool.
      yield { type: "modelMessageStartEvent", role: "assistant" };
      yield {
        type: "modelContentBlockStartEvent",
        start: {
          type: "toolUseStart",
          name: this.toolName,
          toolUseId: "tool-use-1",
        },
      };
      yield {
        type: "modelContentBlockDeltaEvent",
        delta: {
          type: "toolUseInputDelta",
          input: JSON.stringify(this.toolInput),
        },
      };
      yield { type: "modelContentBlockStopEvent" };
      yield { type: "modelMessageStopEvent", stopReason: "toolUse" };
      return;
    }
    // Second turn: acknowledge and end.
    yield { type: "modelMessageStartEvent", role: "assistant" };
    yield { type: "modelContentBlockStartEvent" };
    yield {
      type: "modelContentBlockDeltaEvent",
      delta: { type: "textDelta", text: "Briefing report saved." },
    };
    yield { type: "modelContentBlockStopEvent" };
    yield { type: "modelMessageStopEvent", stopReason: "endTurn" };
  }
}

/** A model that never calls a tool — used to verify the no-tool failure path. */
class NoToolModel extends Model {
  public callCount = 0;
  updateConfig(): void {
    // no-op
  }
  getConfig(): { modelId: string } {
    return { modelId: "fake-notool-model" };
  }
  async *stream(): AsyncIterable<ModelStreamEvent> {
    this.callCount += 1;
    yield { type: "modelMessageStartEvent", role: "assistant" };
    yield { type: "modelContentBlockStartEvent" };
    yield {
      type: "modelContentBlockDeltaEvent",
      delta: { type: "textDelta", text: "No report for you." },
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

/** Render an earthquake observation user message (mirrors accumulate.ts). */
function earthquakeMessageText(opts: {
  earthquakeId: string;
  magnitude: number;
  place: string;
  time: string;
}): string {
  return [
    EARTHQUAKE_MESSAGE_PREFIX,
    `- ID: ${opts.earthquakeId}`,
    `- Magnitude: ${opts.magnitude}`,
    `- Location: ${opts.place}`,
    `- Time: ${opts.time}`,
  ].join("\n");
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

/** A snapshot seeded with two earthquake observations and prior analyses. */
function snapshotWithTwoQuakes(
  metadata: Partial<SessionMetadata> = {},
): Snapshot {
  return makeSnapshot({
    messages: [
      {
        role: "user",
        text: earthquakeMessageText({
          earthquakeId: "us7000n123",
          magnitude: 5.2,
          place: "10km SW of Ridgecrest, CA",
          time: "2024-01-15T03:00:00.000Z",
        }),
      },
      { role: "assistant", text: "Moderate quake; monitoring aftershocks." },
      {
        role: "user",
        text: earthquakeMessageText({
          earthquakeId: "us7000n456",
          magnitude: 4.1,
          place: "20km N of Lone Pine, CA",
          time: "2024-01-20T12:00:00.000Z",
        }),
      },
      { role: "assistant", text: "Minor quake, no action needed." },
    ],
    metadata: { invocationCount: 2, ...metadata },
  });
}

/** Parse the last PutObject body that targeted the session key. */
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
  s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
  s3Mock.on(PutObjectCommand).resolves({});
  process.env.SESSIONS_BUCKET_NAME = BUCKET_NAME;
});

afterEach(() => {
  setS3ClientForTesting(undefined);
  setModelForTesting(undefined);
  setReportWriterForTesting(undefined);
  delete process.env.SESSIONS_BUCKET_NAME;
});

afterAll(() => {
  s3Mock.restore();
});

// ---------------------------------------------------------------------------
// processBriefingEvent — happy path
// ---------------------------------------------------------------------------

describe("processBriefingEvent", () => {
  it("synthesizes a report from conversation history and saves it via the Data API", async () => {
    const model = new ToolCallingModel();
    setModelForTesting(model);
    const writer = vi.fn(
      async (
        _customerId: string,
        _report: BriefingReport,
      ): Promise<ReportWriteResult> => ({
        statusCode: 201,
        body: JSON.stringify({ reportId: "ignored" }),
      }),
    );
    setReportWriterForTesting(writer);

    s3Mock
      .on(GetObjectCommand, { Key: sessionKey() })
      .resolves({ Body: streamBody(JSON.stringify(snapshotWithTwoQuakes())) });

    const result = await processBriefingEvent({
      customerId: CUSTOMER_ID,
      config: makeConfig(),
      event: makeEvent(),
    });

    expect(result.status).toBe("generated");
    if (result.status !== "generated") {
      throw new Error("expected generated outcome");
    }
    expect(result.customerId).toBe(CUSTOMER_ID);
    expect(result.eventId).toBe(BRIEFING_EVENT_ID);
    expect(result.reportId).toMatch(/^[0-9a-f-]{36}$/);

    // The trigger message was injected and the LLM was invoked.
    expect(model.calls.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(model.calls[0])).toContain(BRIEFING_TRIGGER_MESSAGE);

    // The Data API received exactly one well-formed report.
    expect(writer).toHaveBeenCalledTimes(1);
    const [customerArg, reportArg] = writer.mock.calls[0];
    expect(customerArg).toBe(CUSTOMER_ID);
    // Host-owned deterministic fields.
    expect(reportArg.customerId).toBe(CUSTOMER_ID);
    expect(reportArg.reportId).toBe(result.reportId);
    expect(reportArg.totalEarthquakes).toBe(2);
    expect(Date.parse(reportArg.periodStart)).toBeLessThan(
      Date.parse(reportArg.periodEnd),
    );
    // LLM-supplied narrative fields.
    expect(reportArg.summary).toBe(SAVE_REPORT_INPUT.summary);
    expect(reportArg.notableQuakes).toHaveLength(1);
    expect(reportArg.notableQuakes[0].earthquakeId).toBe("us7000n123");
  });

  it("clears the conversation and stamps lastBriefingAt on the persisted session", async () => {
    setModelForTesting(new ToolCallingModel());
    setReportWriterForTesting(
      vi.fn(
        async (): Promise<ReportWriteResult> => ({
          statusCode: 201,
          body: "{}",
        }),
      ),
    );
    s3Mock
      .on(GetObjectCommand, { Key: sessionKey() })
      .resolves({ Body: streamBody(JSON.stringify(snapshotWithTwoQuakes())) });

    await processBriefingEvent({
      customerId: CUSTOMER_ID,
      config: makeConfig(),
      event: makeEvent(),
    });

    const snapshot = persistedSnapshot();
    expect(snapshot).toBeDefined();
    const data = snapshot!.data as unknown as {
      messages: unknown[];
      state: Record<string, SessionMetadata>;
    };
    // Context-window strategy: conversation cleared after the report is saved.
    expect(data.messages).toHaveLength(0);
    const metadata = data.state[SESSION_METADATA_KEY];
    expect(metadata.lastBriefingAt).not.toBeNull();
    expect(metadata.processedEventIds).toContain(BRIEFING_EVENT_ID);
  });

  it("uses periodStart = lastBriefingAt when present", async () => {
    setModelForTesting(new ToolCallingModel());
    const writer = vi.fn(
      async (
        _customerId: string,
        _report: BriefingReport,
      ): Promise<ReportWriteResult> => ({ statusCode: 201, body: "{}" }),
    );
    setReportWriterForTesting(writer);

    const lastBriefingAt = "2024-01-10T09:00:00.000Z";
    s3Mock.on(GetObjectCommand, { Key: sessionKey() }).resolves({
      Body: streamBody(
        JSON.stringify(snapshotWithTwoQuakes({ lastBriefingAt })),
      ),
    });

    await processBriefingEvent({
      customerId: CUSTOMER_ID,
      config: makeConfig(),
      event: makeEvent(),
    });

    const reportArg = writer.mock.calls[0][1];
    expect(reportArg.periodStart).toBe(lastBriefingAt);
  });

  // -------------------------------------------------------------------------
  // Idempotency & empty-report guards (Requirements 7.1, 7.3)
  // -------------------------------------------------------------------------

  it("skips a duplicate trigger already in session metadata without invoking the LLM", async () => {
    const model = new ToolCallingModel();
    setModelForTesting(model);
    const writer = vi.fn(
      async (): Promise<ReportWriteResult> => ({ statusCode: 201, body: "{}" }),
    );
    setReportWriterForTesting(writer);

    s3Mock.on(GetObjectCommand, { Key: sessionKey() }).resolves({
      Body: streamBody(
        JSON.stringify(
          snapshotWithTwoQuakes({ processedEventIds: [BRIEFING_EVENT_ID] }),
        ),
      ),
    });

    const result = await processBriefingEvent({
      customerId: CUSTOMER_ID,
      config: makeConfig(),
      event: makeEvent(),
    });

    expect(result).toEqual({
      status: "skipped",
      reason: "duplicate",
      customerId: CUSTOMER_ID,
      eventId: BRIEFING_EVENT_ID,
    });
    expect(model.calls).toHaveLength(0);
    expect(writer).not.toHaveBeenCalled();
    expect(persistedSnapshot()).toBeUndefined();
  });

  it("skips (no-activity) when there are no earthquake observations, producing no report", async () => {
    const model = new ToolCallingModel();
    setModelForTesting(model);
    const writer = vi.fn(
      async (): Promise<ReportWriteResult> => ({ statusCode: 201, body: "{}" }),
    );
    setReportWriterForTesting(writer);

    // A session with only non-earthquake chatter (no observations).
    s3Mock.on(GetObjectCommand, { Key: sessionKey() }).resolves({
      Body: streamBody(
        JSON.stringify(
          makeSnapshot({
            messages: [
              { role: "user", text: "Hello there." },
              { role: "assistant", text: "Hi! No earthquakes yet." },
            ],
            metadata: { invocationCount: 1 },
          }),
        ),
      ),
    });

    const result = await processBriefingEvent({
      customerId: CUSTOMER_ID,
      config: makeConfig(),
      event: makeEvent(),
    });

    expect(result).toEqual({
      status: "skipped",
      reason: "no-activity",
      customerId: CUSTOMER_ID,
      eventId: BRIEFING_EVENT_ID,
    });
    expect(model.calls).toHaveLength(0);
    expect(writer).not.toHaveBeenCalled();
    expect(persistedSnapshot()).toBeUndefined();
  });

  it("skips (no-activity) on an empty/missing session", async () => {
    setModelForTesting(new ToolCallingModel());
    setReportWriterForTesting(
      vi.fn(
        async (): Promise<ReportWriteResult> => ({
          statusCode: 201,
          body: "{}",
        }),
      ),
    );
    s3Mock
      .on(GetObjectCommand, { Key: sessionKey() })
      .rejects(Object.assign(new Error("missing"), { name: "NoSuchKey" }));

    const result = await processBriefingEvent({
      customerId: CUSTOMER_ID,
      config: makeConfig(),
      event: makeEvent(),
    });

    expect(result.status).toBe("skipped");
    if (result.status !== "skipped") {
      throw new Error("expected skipped outcome");
    }
    expect(result.reason).toBe("no-activity");
  });

  // -------------------------------------------------------------------------
  // Failure paths (Requirement 15.2 — retry on failure, persist nothing)
  // -------------------------------------------------------------------------

  it("throws and persists nothing when the Data API report write fails", async () => {
    setModelForTesting(new ToolCallingModel());
    setReportWriterForTesting(
      vi.fn(
        async (): Promise<ReportWriteResult> => ({
          statusCode: 503,
          body: "unavailable",
        }),
      ),
    );
    s3Mock
      .on(GetObjectCommand, { Key: sessionKey() })
      .resolves({ Body: streamBody(JSON.stringify(snapshotWithTwoQuakes())) });

    await expect(
      processBriefingEvent({
        customerId: CUSTOMER_ID,
        config: makeConfig(),
        event: makeEvent(),
      }),
    ).rejects.toThrow(/503/);

    // No session write occurred, so the SQS message can safely retry.
    expect(persistedSnapshot()).toBeUndefined();
  });

  it("throws and persists nothing when the LLM never calls save_report", async () => {
    setModelForTesting(new NoToolModel());
    const writer = vi.fn(
      async (): Promise<ReportWriteResult> => ({ statusCode: 201, body: "{}" }),
    );
    setReportWriterForTesting(writer);
    s3Mock
      .on(GetObjectCommand, { Key: sessionKey() })
      .resolves({ Body: streamBody(JSON.stringify(snapshotWithTwoQuakes())) });

    await expect(
      processBriefingEvent({
        customerId: CUSTOMER_ID,
        config: makeConfig(),
        event: makeEvent(),
      }),
    ).rejects.toThrow(/did not produce a saved report/);

    expect(writer).not.toHaveBeenCalled();
    expect(persistedSnapshot()).toBeUndefined();
  });
});
