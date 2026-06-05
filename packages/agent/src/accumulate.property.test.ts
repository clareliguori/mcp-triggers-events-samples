/**
 * Property 6: Idempotent Event Processing (task 9.6).
 *
 * SQS delivers at-least-once, so the agent must treat a re-delivered event as a
 * no-op. This property drives the REAL processing paths — a genuine Strands
 * {@link Agent} + {@link SessionManager} + the SDK's {@link S3Storage} — against a
 * **stateful, in-memory S3 mock** so that the *second* delivery actually reads
 * back the session the *first* delivery persisted (the round-trip is what makes
 * idempotency observable). For ANY generated event(s) this pins the contract:
 *
 *   - Req 7.1 — a delivery whose `eventId` is already in the session metadata is
 *     skipped and returns success.
 *   - Req 7.2 — the same earthquake never appears as a duplicate user message in
 *     the conversation history, no matter how many times it is delivered.
 *   - Req 7.3 — a duplicate `briefing.trigger` after a briefing was generated
 *     does not produce a second (or empty) report.
 *
 * The unifying invariant checked across all properties: **the persisted session
 * snapshot after re-delivering an already-processed event is byte-identical to
 * the snapshot after the first processing** — i.e. processing is idempotent.
 *
 * Both fake models ({@link FakeAnalysisModel} for earthquakes, the inline
 * tool-calling model for briefings) and a captured report writer
 * ({@link setReportWriterForTesting}) keep the test free of AWS / LLM / network
 * access while exercising the real restore -> idempotency -> persist path.
 *
 * **Validates: Requirements 7.1, 7.2, 7.3**
 */

import {
  DeleteObjectCommand,
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
import fc from "fast-check";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EARTHQUAKE_MESSAGE_PREFIX,
  SESSION_METADATA_KEY,
  type SessionMetadata,
  processEarthquakeEvent,
  setModelForTesting,
  setS3ClientForTesting,
} from "./accumulate.js";
import {
  processBriefingEvent,
  setReportWriterForTesting,
  type ReportWriteResult,
} from "./briefing.js";

/** Per-property run count. The task requires >= 100; the agent loop is light
 * (everything is in-memory) so 100 runs stay well within the test timeout. */
const NUM_RUNS = 100;

const BUCKET_NAME = "test-sessions-bucket";
const CUSTOMER_ID = "33333333-3333-4333-8333-333333333333";
const BRIEFING_EVENT_ID = "44444444-4444-4444-8444-444444444444";

const s3Mock = mockClient(S3Client);

// ---------------------------------------------------------------------------
// Stateful in-memory S3 store
// ---------------------------------------------------------------------------

/**
 * A tiny in-memory stand-in for the sessions bucket. Unlike the static
 * `resolves(...)` stubs in the unit tests, this store remembers every
 * `PutObject` so a later `GetObject` for the same key reads it back — the exact
 * behavior idempotency depends on (the second delivery must see the first
 * delivery's persisted session). One fresh store is installed per fast-check
 * iteration so runs never bleed into each other.
 */
function installStatefulS3(store: Map<string, string>): void {
  s3Mock.reset();
  setS3ClientForTesting(s3Mock as unknown as S3Client);

  s3Mock.on(PutObjectCommand).callsFake((input: Record<string, unknown>) => {
    store.set(input.Key as string, input.Body as string);
    return {};
  });

  s3Mock.on(GetObjectCommand).callsFake((input: Record<string, unknown>) => {
    const key = input.Key as string;
    if (!store.has(key)) {
      // Mirrors a real "missing object" so the SDK S3Storage returns null.
      throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
    }
    return { Body: streamBody(store.get(key)!) };
  });

  s3Mock
    .on(ListObjectsV2Command)
    .callsFake((input: Record<string, unknown>) => {
      const prefix = (input.Prefix as string | undefined) ?? "";
      const Contents = [...store.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((Key) => ({ Key }));
      return { Contents };
    });

  s3Mock.on(DeleteObjectCommand).callsFake((input: Record<string, unknown>) => {
    store.delete(input.Key as string);
    return {};
  });
}

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

/** Shape of the persisted session snapshot's `data` block. */
interface SnapshotData {
  messages: { role: string; content: { text?: string }[] }[];
  state: Record<string, SessionMetadata>;
}

/** Parse the currently-persisted session snapshot's `data` from the store. */
function readPersistedData(store: Map<string, string>): SnapshotData {
  const raw = store.get(sessionKey());
  if (raw === undefined) {
    throw new Error("no session snapshot persisted");
  }
  return (JSON.parse(raw) as Snapshot).data as unknown as SnapshotData;
}

/** Count user messages that are earthquake observations (Req 7.2). */
function countEarthquakeMessages(data: SnapshotData): number {
  return data.messages.filter(
    (m) =>
      m.role === "user" &&
      (m.content[0]?.text ?? "").startsWith(EARTHQUAKE_MESSAGE_PREFIX),
  ).length;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A minimal, schema-valid CustomerConfig for the test customer. */
function makeConfig(): CustomerConfig {
  return {
    customerId: CUSTOMER_ID,
    displayName: "Test Customer",
    subscriptionParams: { minMagnitude: 2.5 },
    briefingPrompt: "You are a seismologist. Analyze earthquakes concisely.",
    briefingSchedule: 24,
    active: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// Fake models
// ---------------------------------------------------------------------------

/**
 * Deterministic stand-in for a Bedrock model that streams a single fixed text
 * response, enough for the agent loop to append one assistant message and stop.
 * Counts invocations so a test can assert a skipped (duplicate) delivery never
 * reaches the model.
 */
class FakeAnalysisModel extends Model {
  public callCount = 0;

  updateConfig(): void {
    // no-op for the fake
  }

  getConfig(): { modelId: string } {
    return { modelId: "fake-analysis-model" };
  }

  async *stream(
    _messages: Message[],
    _options?: StreamOptions,
  ): AsyncIterable<ModelStreamEvent> {
    this.callCount += 1;
    yield { type: "modelMessageStartEvent", role: "assistant" };
    yield { type: "modelContentBlockStartEvent" };
    yield {
      type: "modelContentBlockDeltaEvent",
      delta: { type: "textDelta", text: "Analyzed earthquake in context." },
    };
    yield { type: "modelContentBlockStopEvent" };
    yield { type: "modelMessageStopEvent", stopReason: "endTurn" };
  }
}

/**
 * Deterministic stand-in that simulates the LLM calling the `save_report` tool
 * on its first turn (so the briefing path persists a report) and ending the
 * turn on the second. Counts invocations so a skipped duplicate trigger can be
 * shown to never reach the model.
 */
class FakeBriefingModel extends Model {
  public callCount = 0;

  updateConfig(): void {
    // no-op for the fake
  }

  getConfig(): { modelId: string } {
    return { modelId: "fake-briefing-model" };
  }

  async *stream(
    _messages: Message[],
    _options?: StreamOptions,
  ): AsyncIterable<ModelStreamEvent> {
    this.callCount += 1;
    if (this.callCount === 1) {
      yield { type: "modelMessageStartEvent", role: "assistant" };
      yield {
        type: "modelContentBlockStartEvent",
        start: {
          type: "toolUseStart",
          name: "save_report",
          toolUseId: "tool-use-1",
        },
      };
      yield {
        type: "modelContentBlockDeltaEvent",
        delta: {
          type: "toolUseInputDelta",
          input: JSON.stringify({
            summary: "Synthesized summary of this period's activity.",
            notableQuakes: [],
            geographicPatterns: "Clustering observed across the regions.",
            comparisonToPrevious: "Comparable to the previous period.",
          }),
        },
      };
      yield { type: "modelContentBlockStopEvent" };
      yield { type: "modelMessageStopEvent", stopReason: "toolUse" };
      return;
    }
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

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const placeArb = fc.constantFrom(
  "10km SW of Ridgecrest, CA",
  "20km N of Lone Pine, CA",
  "5km E of Anchorage, AK",
  "near the east coast of Honshu, Japan",
  "Central Italy",
  "offshore Valparaiso, Chile",
);

/** Magnitude in [0, 10], rounded to one decimal for a tidy printed message. */
const magnitudeArb = fc
  .double({ min: 0, max: 10, noNaN: true })
  .map((m) => Math.round(m * 10) / 10);

/** Occurrence times in a broad past window. */
const timeMsArb = fc.integer({
  min: Date.parse("2020-01-01T00:00:00.000Z"),
  max: Date.parse("2024-12-31T00:00:00.000Z"),
});

const earthquakeDataArb: fc.Arbitrary<EarthquakeDetectedData> = fc.record({
  // `us` + hex keeps ids URL-safe and newline-free.
  earthquakeId: fc
    .hexaString({ minLength: 6, maxLength: 10 })
    .map((h) => `us${h}`),
  magnitude: magnitudeArb,
  place: placeArb,
  coordinates: fc.record({
    longitude: fc.double({ min: -180, max: 180, noNaN: true }),
    latitude: fc.double({ min: -90, max: 90, noNaN: true }),
    depth: fc.double({ min: 0, max: 700, noNaN: true }),
  }),
  time: timeMsArb.map((ms) => new Date(ms).toISOString()),
  tsunami: fc.boolean(),
  felt: fc.option(fc.nat({ max: 100_000 }), { nil: null }),
  alert: fc.option(fc.constantFrom("green", "yellow", "orange", "red"), {
    nil: null,
  }),
  url: fc.webUrl(),
});

/** A full `earthquake.detected` event with a UUID v4 `eventId`. */
const earthquakeEventArb: fc.Arbitrary<
  McpEventPayload<EarthquakeDetectedData>
> = fc
  .record({ eventId: fc.uuid({ version: 4 }), data: earthquakeDataArb })
  .map(({ eventId, data }) => ({
    eventId,
    name: "earthquake.detected" as const,
    timestamp: data.time,
    data,
    cursor: `cursor-${eventId}`,
  }));

/** 1..4 earthquake events with DISTINCT `eventId`s. */
const earthquakeEventsArb = fc.uniqueArray(earthquakeEventArb, {
  minLength: 1,
  maxLength: 4,
  selector: (e) => e.eventId,
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  s3Mock.reset();
  setS3ClientForTesting(s3Mock as unknown as S3Client);
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
// Property 6 — earthquake idempotency (Requirements 7.1, 7.2)
// ---------------------------------------------------------------------------

describe("Property 6: Idempotent Event Processing — earthquakes", () => {
  it("7.1/7.2: delivering the same earthquake twice is processed once then skipped, leaving the session identical", async () => {
    await fc.assert(
      fc.asyncProperty(earthquakeEventArb, async (event) => {
        const store = new Map<string, string>();
        installStatefulS3(store);
        const model = new FakeAnalysisModel();
        setModelForTesting(model);

        // First delivery: processed (no prior session in the store).
        const first = await processEarthquakeEvent({
          customerId: CUSTOMER_ID,
          config: makeConfig(),
          event,
        });
        expect(first.status).toBe("processed");
        expect(model.callCount).toBe(1);

        const afterFirst = store.get(sessionKey());
        expect(afterFirst).toBeDefined();

        // Second delivery of the SAME event: skipped, model not re-invoked.
        const second = await processEarthquakeEvent({
          customerId: CUSTOMER_ID,
          config: makeConfig(),
          event,
        });
        expect(second).toEqual({
          status: "skipped",
          customerId: CUSTOMER_ID,
          eventId: event.eventId,
        });
        expect(model.callCount).toBe(1);

        // Idempotency: the persisted snapshot is byte-identical (nothing was
        // written on the duplicate), so session state is unchanged.
        expect(store.get(sessionKey())).toBe(afterFirst);

        // Exactly one earthquake observation (Req 7.2) + its single analysis.
        const data = readPersistedData(store);
        expect(countEarthquakeMessages(data)).toBe(1);
        expect(data.messages).toHaveLength(2);

        // The event is recorded exactly once in the idempotency window.
        const ids = data.state[SESSION_METADATA_KEY].processedEventIds;
        expect(ids.filter((id) => id === event.eventId)).toHaveLength(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("7.1/7.2: re-delivering an arbitrary sequence of events never duplicates earthquakes or changes state", async () => {
    await fc.assert(
      fc.asyncProperty(earthquakeEventsArb, async (events) => {
        const store = new Map<string, string>();
        installStatefulS3(store);
        setModelForTesting(new FakeAnalysisModel());

        // First pass: process every distinct event once.
        for (const event of events) {
          const result = await processEarthquakeEvent({
            customerId: CUSTOMER_ID,
            config: makeConfig(),
            event,
          });
          expect(result.status).toBe("processed");
        }

        const afterFirstPass = store.get(sessionKey());
        const dataAfterFirst = readPersistedData(store);
        // One earthquake user message per distinct event; no duplicates.
        expect(countEarthquakeMessages(dataAfterFirst)).toBe(events.length);
        expect(dataAfterFirst.messages).toHaveLength(events.length * 2);

        // Second pass: re-deliver each event — all are duplicates now.
        for (const event of events) {
          const result = await processEarthquakeEvent({
            customerId: CUSTOMER_ID,
            config: makeConfig(),
            event,
          });
          expect(result.status).toBe("skipped");
        }

        // The session snapshot is unchanged after the full re-delivery.
        expect(store.get(sessionKey())).toBe(afterFirstPass);

        // Each eventId is recorded exactly once (no duplicate bookkeeping).
        const ids =
          readPersistedData(store).state[SESSION_METADATA_KEY]
            .processedEventIds;
        for (const event of events) {
          expect(ids.filter((id) => id === event.eventId)).toHaveLength(1);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6 — briefing idempotency / no duplicate reports (Requirements 7.1, 7.3)
// ---------------------------------------------------------------------------

/** Render an earthquake observation user message (mirrors accumulate.ts). */
function earthquakeMessageText(data: EarthquakeDetectedData): string {
  return [
    EARTHQUAKE_MESSAGE_PREFIX,
    `- ID: ${data.earthquakeId}`,
    `- Magnitude: ${data.magnitude}`,
    `- Location: ${data.place}`,
    `- Time: ${data.time}`,
  ].join("\n");
}

/** Build a session snapshot seeded with the given earthquake observations. */
function seededSnapshot(quakes: EarthquakeDetectedData[]): Snapshot {
  const messages: {
    role: "user" | "assistant";
    content: { text: string }[];
  }[] = [];
  for (const quake of quakes) {
    messages.push({
      role: "user",
      content: [{ text: earthquakeMessageText(quake) }],
    });
    messages.push({
      role: "assistant",
      content: [{ text: `Logged ${quake.earthquakeId}.` }],
    });
  }
  const metadata: SessionMetadata = {
    lastEventId: "",
    lastActiveAt: "",
    invocationCount: quakes.length,
    lastBriefingAt: null,
    customerDisplayName: "Test Customer",
    processedEventIds: [],
  };
  return {
    scope: "agent",
    schemaVersion: "1.0",
    createdAt: "2024-01-01T00:00:00.000Z",
    data: { messages, state: { [SESSION_METADATA_KEY]: metadata } },
    appData: {},
  } as unknown as Snapshot;
}

function makeBriefingEvent(): McpEventPayload<BriefingTriggerData> {
  return {
    eventId: BRIEFING_EVENT_ID,
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

describe("Property 6: Idempotent Event Processing — briefings", () => {
  it("7.1/7.3: delivering the same briefing trigger twice generates exactly one report and leaves the session identical", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(earthquakeDataArb, {
          minLength: 1,
          maxLength: 4,
          selector: (q) => q.earthquakeId,
        }),
        async (quakes) => {
          const store = new Map<string, string>();
          installStatefulS3(store);
          store.set(sessionKey(), JSON.stringify(seededSnapshot(quakes)));

          const model = new FakeBriefingModel();
          setModelForTesting(model);

          let reportWrites = 0;
          const savedReports: BriefingReport[] = [];
          setReportWriterForTesting(
            async (_customerId, report): Promise<ReportWriteResult> => {
              reportWrites += 1;
              savedReports.push(report);
              return { statusCode: 201, body: "{}" };
            },
          );

          // First delivery: a report is generated and saved.
          const first = await processBriefingEvent({
            customerId: CUSTOMER_ID,
            config: makeConfig(),
            event: makeBriefingEvent(),
          });
          expect(first.status).toBe("generated");
          expect(reportWrites).toBe(1);

          const afterFirst = store.get(sessionKey());
          expect(afterFirst).toBeDefined();
          const modelCallsAfterFirst = model.callCount;

          // Second delivery of the SAME trigger: skipped as a duplicate
          // (Req 7.1), so NO second report is written (Req 7.3) and the model
          // is not re-invoked.
          const second = await processBriefingEvent({
            customerId: CUSTOMER_ID,
            config: makeConfig(),
            event: makeBriefingEvent(),
          });
          expect(second).toEqual({
            status: "skipped",
            reason: "duplicate",
            customerId: CUSTOMER_ID,
            eventId: BRIEFING_EVENT_ID,
          });
          expect(reportWrites).toBe(1);
          expect(savedReports).toHaveLength(1);
          expect(model.callCount).toBe(modelCallsAfterFirst);

          // Idempotency: the persisted session is byte-identical after the
          // duplicate delivery.
          expect(store.get(sessionKey())).toBe(afterFirst);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
