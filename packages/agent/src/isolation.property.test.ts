/**
 * Property test for customer isolation (task 9.7, Property 7).
 *
 * **Property 7: Customer Isolation**
 *
 * _For any_ event `e` with subscription mapping to customer `C_a`, the only
 * session file read or written during processing SHALL be
 * `sessions/{C_a}/session.json`. No other customer's session SHALL be accessed,
 * and no earthquakes from customer `C_a`'s session SHALL appear in any other
 * customer's briefing report.
 *
 * **Validates: Requirements 5.1, 5.2**
 *
 * ## Approach
 *
 * These tests drive the REAL agent pipeline — `processEarthquakeEvent` and
 * `processBriefingEvent` (tasks 9.4 / 9.8) running the genuine Strands
 * {@link Agent} + {@link SessionManager} + {@link S3SnapshotStorage} — against
 * an **in-memory, key-addressed S3 mock** that persists each customer's session
 * object (`sessions/{customerId}/session.json`) independently, mirroring the
 * mocking approach in `accumulate.test.ts` and `lock.integration.test.ts`. The
 * LLM is a deterministic fake ({@link FakeModel} for analysis,
 * {@link ToolCallingModel} for briefing synthesis) so no AWS or Bedrock access
 * is needed.
 *
 * fast-check generates arbitrary sequences of `earthquake.detected` events with
 * **mixed customer IDs** (interleaved across a small customer pool). Every
 * earthquake carries an id of the form `quake-c{ownerIndex}-n{seq}` so the
 * owning customer is recoverable from any persisted byte; the property then
 * asserts:
 *
 * 1. **Key-level isolation (Requirement 5.1).** During the processing of a
 *    single event for customer `C`, every S3 key read or written is under the
 *    `sessions/{C}/` prefix — no other customer's session object is touched.
 * 2. **Content-level isolation (Requirement 5.2).** After the whole interleaved
 *    sequence is processed, each customer's persisted session contains only
 *    that customer's earthquake ids (no `quake-c{other}-` token leaks into
 *    another customer's conversation history or metadata), and a customer that
 *    received no events has no session at all.
 * 3. **Briefing isolation (Requirement 5.2).** When a briefing is generated for
 *    customer `C`, the host-owned `totalEarthquakes` equals exactly the number
 *    of earthquakes delivered to `C` (never inflated by another customer's
 *    activity), the LLM's conversation context contains only `C`'s earthquake
 *    ids, and a customer with no activity produces no report at all even when
 *    other customers were busy.
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
  type StreamOptions,
} from "@strands-agents/sdk";
import { mockClient } from "aws-sdk-client-mock";
import fc from "fast-check";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  processEarthquakeEvent,
  setModelForTesting,
  setS3ClientForTesting,
} from "./accumulate.js";
import {
  processBriefingEvent,
  setReportWriterForTesting,
  type ReportWriteResult,
} from "./briefing.js";

// ---------------------------------------------------------------------------
// Fixtures / constants
// ---------------------------------------------------------------------------

const BUCKET_NAME = "test-sessions-bucket";
/** Fixed base for deterministic, parseable earthquake timestamps. */
const BASE_TIME_MS = Date.parse("2024-01-01T00:00:00.000Z");
/** Per-property run count. fast-check defaults to 100; repo style is ~200. */
const NUM_RUNS = 200;
/** Briefing facet drives the real agent loop twice per customer; keep ≥100. */
const NUM_RUNS_BRIEFING = 100;

const s3Mock = mockClient(S3Client);

/**
 * Stable customer id (UUID v4) for a customer pool index. Lowercase hex UUIDs
 * satisfy both the SDK SessionManager identifier rule (`/^[a-z0-9_-]+$/`) and
 * the shared `uuidV4Schema` the briefing report (and Data API) enforce — so the
 * briefing path's `save_report` validation accepts the assembled report.
 *
 * Owner identity for the isolation assertions is carried separately by the
 * earthquake ids (`quake-c{index}-n{seq}`), which never collide with these
 * UUIDs, so the two stay cleanly decoupled.
 */
function custId(index: number): string {
  const hex = index.toString(16).padStart(2, "0");
  return `000000${hex}-0000-4000-8000-000000000000`;
}

/** The S3 key for a customer's session snapshot. */
function sessionKey(customerId: string): string {
  return `sessions/${customerId}/session.json`;
}

/** A minimal CustomerConfig for a generated customer. */
function makeConfig(customerId: string): CustomerConfig {
  return {
    customerId,
    displayName: `Customer ${customerId}`,
    subscriptionParams: { minMagnitude: 0 },
    briefingPrompt: "You are a seismologist. Analyze earthquakes concisely.",
    briefingSchedule: "0 9 * * *",
    active: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

/**
 * Build an `earthquake.detected` event whose earthquake id encodes its owning
 * customer (`quake-c{ownerIndex}-n{seq}`) and whose eventId is globally unique
 * (`evt-c{ownerIndex}-n{seq}`), so ownership is recoverable from any persisted
 * byte and no idempotency skip is ever triggered across the sequence.
 */
function makeEarthquakeEvent(
  ownerIndex: number,
  seq: number,
  magnitude: number,
): McpEventPayload<EarthquakeDetectedData> {
  const earthquakeId = `quake-c${ownerIndex}-n${seq}`;
  const iso = new Date(BASE_TIME_MS + seq * 60_000).toISOString();
  return {
    eventId: `evt-c${ownerIndex}-n${seq}`,
    name: "earthquake.detected",
    timestamp: iso,
    data: {
      earthquakeId,
      magnitude,
      place: `Region for customer ${ownerIndex}`,
      coordinates: { longitude: -100 + ownerIndex, latitude: 30, depth: 10 },
      time: iso,
      tsunami: false,
      felt: null,
      alert: null,
      url: `https://earthquake.usgs.gov/eventpage/${earthquakeId}`,
    },
    cursor: `cursor-${seq}`,
  };
}

/** A `briefing.trigger` event for a customer. */
function makeBriefingEvent(
  customerId: string,
): McpEventPayload<BriefingTriggerData> {
  return {
    eventId: `brief-${customerId}`,
    name: "briefing.trigger",
    timestamp: new Date().toISOString(),
    data: {
      triggerType: "scheduled",
      customerId,
      scheduledTime: new Date().toISOString(),
    },
    cursor: `cursor-brief-${customerId}`,
  };
}

// ---------------------------------------------------------------------------
// Fake models
// ---------------------------------------------------------------------------

/**
 * Deterministic analysis model. Streams a single fixed text response that
 * deliberately contains NO earthquake id, so the only `quake-c*-n*` tokens that
 * can ever appear in a persisted session originate from the injected user
 * messages — i.e. from that customer's own events.
 */
class FakeModel extends Model {
  updateConfig(): void {
    // no-op for the fake
  }
  getConfig(): { modelId: string } {
    return { modelId: "fake-model" };
  }
  async *stream(
    _messages: Message[],
    _options?: StreamOptions,
  ): AsyncIterable<ModelStreamEvent> {
    yield { type: "modelMessageStartEvent", role: "assistant" };
    yield { type: "modelContentBlockStartEvent" };
    yield {
      type: "modelContentBlockDeltaEvent",
      delta: { type: "textDelta", text: "Noted; analysis recorded." },
    };
    yield { type: "modelContentBlockStopEvent" };
    yield { type: "modelMessageStopEvent", stopReason: "endTurn" };
  }
}

/** Narrative fields the briefing fake supplies to the save_report tool. */
const SAVE_REPORT_INPUT = {
  summary: "Seismic activity summary for the period.",
  notableQuakes: [],
  geographicPatterns: "No notable clustering.",
  comparisonToPrevious: "Comparable to the previous period.",
};

/**
 * Briefing model that simulates an LLM calling `save_report` on its first turn
 * and acknowledging on its second. Records each conversation it was given so a
 * test can assert the LLM only ever saw one customer's earthquake ids. A fresh
 * instance must be used per briefing (callCount is per-instance).
 */
class ToolCallingModel extends Model {
  public callCount = 0;
  public readonly calls: Message[][] = [];

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
    this.calls.push([...messages]);
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
          input: JSON.stringify(SAVE_REPORT_INPUT),
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
// In-memory, key-addressed S3 mock
// ---------------------------------------------------------------------------

/** Wrap a JSON string as a mocked S3 streaming body. */
function streamBody(text: string): GetObjectCommandOutput["Body"] {
  return {
    transformToString: async () => text,
  } as unknown as GetObjectCommandOutput["Body"];
}

/** Handle to an in-memory S3 store plus a recorder of touched object keys. */
interface FreshS3 {
  /** key -> JSON body, persisting each customer's session independently. */
  store: Map<string, string>;
  /** Keys touched (get/put/list/delete) since the last reset of this array. */
  touchedKeys: string[];
}

/**
 * Reset the shared S3 mock and wire it to a fresh in-memory store keyed purely
 * by object Key, so each customer's `sessions/{id}/session.json` lives at its
 * own address and never collides with another's. Returns the store and a
 * `touchedKeys` recorder used to assert per-event key isolation.
 */
function freshS3(): FreshS3 {
  s3Mock.reset();
  const store = new Map<string, string>();
  const touchedKeys: string[] = [];

  s3Mock.on(GetObjectCommand).callsFake((input: { Key?: string }) => {
    const key = input.Key ?? "";
    touchedKeys.push(key);
    const body = store.get(key);
    if (body === undefined) {
      throw Object.assign(new Error(`no such key: ${key}`), {
        name: "NoSuchKey",
      });
    }
    return { Body: streamBody(body) };
  });

  s3Mock
    .on(PutObjectCommand)
    .callsFake((input: { Key?: string; Body?: unknown }) => {
      const key = input.Key ?? "";
      touchedKeys.push(key);
      store.set(key, String(input.Body));
      return {};
    });

  s3Mock.on(ListObjectsV2Command).callsFake((input: { Prefix?: string }) => {
    const prefix = input.Prefix ?? "";
    const contents = [...store.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((Key) => ({ Key }));
    touchedKeys.push(...contents.map((c) => c.Key));
    return { Contents: contents };
  });

  s3Mock.on(DeleteObjectCommand).callsFake((input: { Key?: string }) => {
    const key = input.Key ?? "";
    touchedKeys.push(key);
    store.delete(key);
    return {};
  });

  return { store, touchedKeys };
}

/** Every owner index referenced by any `quake-c{n}-` token in `text`. */
function ownerIndicesIn(text: string): number[] {
  return [...text.matchAll(/quake-c(\d+)-n\d+/g)].map((m) => Number(m[1]));
}

// ---------------------------------------------------------------------------
// Scenario generator
// ---------------------------------------------------------------------------

/**
 * A small customer pool plus an interleaved sequence of per-event owner
 * assignments. The repeated, shuffled owner indices are exactly the "mixed
 * customer IDs" the property targets. `magnitudes` are paired 1:1 with
 * assignments. Capped at 12 events so even an all-to-one-customer run stays
 * under the SDK sliding window (40 messages = 20 exchanges), guaranteeing no
 * history is trimmed and the per-customer earthquake count is exact.
 */
const scenarioArb = fc.integer({ min: 2, max: 4 }).chain((numCustomers) =>
  fc.record({
    numCustomers: fc.constant(numCustomers),
    assignments: fc.array(fc.integer({ min: 0, max: numCustomers - 1 }), {
      minLength: 1,
      maxLength: 12,
    }),
    magnitudes: fc.array(fc.float({ min: 0, max: 10, noNaN: true }), {
      minLength: 12,
      maxLength: 12,
    }),
  }),
);

// ---------------------------------------------------------------------------
// Shared driver
// ---------------------------------------------------------------------------

interface ProcessedScenario {
  /** owner index -> earthquake ids delivered to that customer, in order. */
  sentByCustomer: Map<number, string[]>;
}

/**
 * Process the full interleaved earthquake sequence with {@link FakeModel},
 * asserting per-event key isolation (Requirement 5.1) as it goes, and return
 * the ground-truth map of which earthquakes each customer received.
 */
async function processEarthquakes(
  assignments: number[],
  magnitudes: number[],
  s3: FreshS3,
): Promise<ProcessedScenario> {
  setModelForTesting(new FakeModel());
  const sentByCustomer = new Map<number, string[]>();

  for (let seq = 0; seq < assignments.length; seq++) {
    const ownerIndex = assignments[seq];
    const customerId = custId(ownerIndex);
    const event = makeEarthquakeEvent(ownerIndex, seq, magnitudes[seq]);

    // Reset the recorder so we observe only this single event's S3 access.
    s3.touchedKeys.length = 0;
    const result = await processEarthquakeEvent({
      customerId,
      config: makeConfig(customerId),
      event,
    });
    expect(result.status).toBe("processed");

    // Requirement 5.1: only this customer's session object was touched.
    const allowedPrefix = `sessions/${customerId}/`;
    for (const key of s3.touchedKeys) {
      expect(key.startsWith(allowedPrefix)).toBe(true);
    }

    const prior = sentByCustomer.get(ownerIndex) ?? [];
    prior.push(event.data.earthquakeId);
    sentByCustomer.set(ownerIndex, prior);
  }

  return { sentByCustomer };
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
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
// Property 7: Customer Isolation
// ---------------------------------------------------------------------------

describe("Property 7: Customer Isolation", () => {
  it("5.1: processing an event for customer C only reads/writes sessions/{C}/", async () => {
    // Validates: Requirement 5.1 (key-level isolation, asserted per event in
    // the shared driver across an arbitrary interleaved sequence).
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ assignments, magnitudes }) => {
        const s3 = freshS3();
        await processEarthquakes(assignments, magnitudes, s3);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("5.2: each customer's session contains only that customer's earthquakes", async () => {
    // Validates: Requirement 5.2 (content-level isolation — no cross-customer
    // leakage in conversation history or metadata).
    await fc.assert(
      fc.asyncProperty(
        scenarioArb,
        async ({ numCustomers, assignments, magnitudes }) => {
          const s3 = freshS3();
          const { sentByCustomer } = await processEarthquakes(
            assignments,
            magnitudes,
            s3,
          );

          for (let ci = 0; ci < numCustomers; ci++) {
            const body = s3.store.get(sessionKey(custId(ci)));
            const own = sentByCustomer.get(ci);

            if (own === undefined) {
              // A customer that received no events has no session at all — no
              // other customer's activity created one for it.
              expect(body).toBeUndefined();
              continue;
            }

            expect(body).toBeDefined();
            // No foreign earthquake id appears anywhere in this session.
            for (const owner of ownerIndicesIn(body!)) {
              expect(owner).toBe(ci);
            }
            // Sanity: this customer's own earthquakes are present.
            for (const earthquakeId of own) {
              expect(body!).toContain(earthquakeId);
            }
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("5.2: a customer's briefing reflects only its own earthquakes, never another's", async () => {
    // Validates: Requirement 5.2 (no earthquakes from one customer's session
    // appear in another customer's briefing). The host-owned totalEarthquakes
    // and the LLM's conversation context are both checked for isolation.
    await fc.assert(
      fc.asyncProperty(
        scenarioArb,
        async ({ numCustomers, assignments, magnitudes }) => {
          const s3 = freshS3();
          const { sentByCustomer } = await processEarthquakes(
            assignments,
            magnitudes,
            s3,
          );

          for (let ci = 0; ci < numCustomers; ci++) {
            const customerId = custId(ci);
            const own = sentByCustomer.get(ci) ?? [];

            // Fresh model per briefing: callCount is per-instance.
            const model = new ToolCallingModel();
            setModelForTesting(model);
            const captured: BriefingReport[] = [];
            setReportWriterForTesting(
              async (
                _customerId: string,
                report: BriefingReport,
              ): Promise<ReportWriteResult> => {
                captured.push(report);
                return { statusCode: 201, body: "{}" };
              },
            );

            s3.touchedKeys.length = 0;
            const result = await processBriefingEvent({
              customerId,
              config: makeConfig(customerId),
              event: makeBriefingEvent(customerId),
            });

            // Requirement 5.1 also holds for the briefing path.
            const allowedPrefix = `sessions/${customerId}/`;
            for (const key of s3.touchedKeys) {
              expect(key.startsWith(allowedPrefix)).toBe(true);
            }

            if (own.length === 0) {
              // No activity for this customer: no report is produced, even
              // though other customers were busy.
              expect(result.status).toBe("skipped");
              expect(captured).toHaveLength(0);
              continue;
            }

            expect(result.status).toBe("generated");
            expect(captured).toHaveLength(1);
            const report = captured[0];
            // Host-owned count equals exactly this customer's earthquakes —
            // never inflated by another customer's activity.
            expect(report.customerId).toBe(customerId);
            expect(report.totalEarthquakes).toBe(own.length);
            // The conversation the LLM synthesized contained only this
            // customer's earthquake ids.
            for (const owner of ownerIndicesIn(JSON.stringify(model.calls))) {
              expect(owner).toBe(ci);
            }
          }
        },
      ),
      { numRuns: NUM_RUNS_BRIEFING },
    );
  });
});
