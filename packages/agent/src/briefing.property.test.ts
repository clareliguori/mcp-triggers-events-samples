/**
 * Property 9: Briefing Report Completeness and Integrity (task 9.9).
 *
 * Drives the REAL briefing path (`processBriefingEvent`) — a genuine Strands
 * {@link Agent} + {@link SessionManager} + the SDK's {@link S3Storage} restored
 * from a mocked S3 snapshot — across arbitrary conversation histories generated
 * with fast-check. Each generated history is a sequence of earthquake
 * observation user messages (interleaved with assistant analyses and some
 * non-earthquake chatter) seeded into the restored session snapshot.
 *
 * For ANY such history this pins down the report-generation contract:
 *
 *   1. Req 11.1 — when the briefing is generated, the LLM (a fake {@link Model}
 *      that captures the messages it receives) sees a conversation containing
 *      EVERY seeded earthquake observation, plus the injected trigger message.
 *   2. Req 11.3 — the assembled/saved report carries all narrative fields
 *      (summary, notableQuakes, geographicPatterns, comparisonToPrevious) and a
 *      faithful `totalEarthquakes` count.
 *   3. Req 11.5 — the saved report satisfies `periodStart < periodEnd`.
 *   4. Req 11.6 — `notableQuakes` in the saved report only reference earthquakes
 *      present in the seeded conversation context (the host passes the LLM's
 *      tool input through without inventing or dropping earthquake ids).
 *
 * The fake model echoes a fast-check-chosen subset of the seeded earthquake ids
 * back through the `save_report` tool, and a mocked report writer
 * ({@link setReportWriterForTesting}) captures the assembled {@link
 * BriefingReport} so the assertions never sign or hit the network.
 *
 * **Validates: Requirements 11.1, 11.3, 11.5, 11.6**
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
import fc from "fast-check";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

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

/** Per-property run count. Spec floor is 100 random inputs per property. */
const NUM_RUNS = 100;

const BUCKET_NAME = "test-sessions-bucket";
const CUSTOMER_ID = "33333333-3333-4333-8333-333333333333";
const BRIEFING_EVENT_ID = "44444444-4444-4444-8444-444444444444";

const s3Mock = mockClient(S3Client);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A minimal, schema-valid CustomerConfig for the test customer. */
function makeConfig(): CustomerConfig {
  return {
    customerId: CUSTOMER_ID,
    displayName: "Test Customer",
    subscriptionParams: { minMagnitude: 2.5 },
    briefingPrompt: "You are a seismologist. Summarize earthquakes concisely.",
    briefingSchedule: "0 9 * * *",
    active: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

/** A valid `briefing.trigger` MCP event payload. */
function makeEvent(): McpEventPayload<BriefingTriggerData> {
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

// ---------------------------------------------------------------------------
// Fake model — captures the conversation it is asked to synthesize and
// simulates the LLM calling `save_report` with a chosen set of notable quakes.
// ---------------------------------------------------------------------------

/** Narrative fields the fake model supplies to the `save_report` tool. */
interface SaveReportToolInput {
  summary: string;
  notableQuakes: {
    earthquakeId: string;
    magnitude: number;
    place: string;
    reason: string;
  }[];
  geographicPatterns: string;
  comparisonToPrevious: string;
}

/**
 * Deterministic stand-in for a Bedrock model. On the first invocation it streams
 * a `save_report` tool-use block (so the agent executes the tool); on the next
 * invocation it streams a short acknowledgement and ends the turn. It records a
 * shallow copy of the messages it receives on each call so the test can assert
 * the LLM saw the full conversation history (the briefing path clears the
 * messages array in place after saving, so a reference would not survive).
 */
class CapturingToolModel extends Model {
  public callCount = 0;
  public readonly calls: Message[][] = [];

  constructor(private readonly toolInput: SaveReportToolInput) {
    super();
  }

  updateConfig(): void {
    // no-op for the fake
  }

  getConfig(): { modelId: string } {
    return { modelId: "fake-capturing-model" };
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
          input: JSON.stringify(this.toolInput),
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

/** Concatenate the text content of a captured {@link Message}. */
function messageText(message: Message): string {
  const blocks = message.content as unknown as { text?: unknown }[];
  return blocks
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .join("\n");
}

/** Render an earthquake observation user message (mirrors accumulate.ts). */
function earthquakeMessageText(quake: GeneratedQuake): string {
  return [
    EARTHQUAKE_MESSAGE_PREFIX,
    `- ID: ${quake.id}`,
    `- Magnitude: ${quake.magnitude}`,
    `- Location: ${quake.place}`,
    `- Time: ${new Date(quake.timeMs).toISOString()}`,
  ].join("\n");
}

/**
 * Build a Strands SDK `Snapshot` whose conversation history holds, in order: a
 * non-earthquake chatter exchange (to prove the observation count excludes
 * non-observations), then for each generated quake an earthquake observation
 * user message followed by an assistant analysis.
 */
function buildSnapshot(
  quakes: GeneratedQuake[],
  lastBriefingAtMs: number | null,
): Snapshot {
  const messages: {
    role: "user" | "assistant";
    content: { text: string }[];
  }[] = [
    { role: "user", content: [{ text: "Hello, any seismic activity?" }] },
    { role: "assistant", content: [{ text: "Standing by for events." }] },
  ];
  for (const quake of quakes) {
    messages.push({
      role: "user",
      content: [{ text: earthquakeMessageText(quake) }],
    });
    messages.push({
      role: "assistant",
      content: [{ text: `Logged ${quake.id} (M${quake.magnitude}).` }],
    });
  }

  const metadata: SessionMetadata = {
    lastEventId: "",
    lastActiveAt: "",
    invocationCount: quakes.length,
    lastBriefingAt:
      lastBriefingAtMs === null
        ? null
        : new Date(lastBriefingAtMs).toISOString(),
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

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** A single synthetic earthquake observation seeded into the conversation. */
interface GeneratedQuake {
  id: string;
  magnitude: number;
  place: string;
  timeMs: number;
}

/** A scenario: the seeded conversation, the LLM's chosen notable subset, and
 * the optional prior-briefing time that anchors `periodStart`. */
interface Scenario {
  quakes: GeneratedQuake[];
  notable: GeneratedQuake[];
  lastBriefingAtMs: number | null;
}

const placeArb = fc.constantFrom(
  "10km SW of Ridgecrest, CA",
  "20km N of Lone Pine, CA",
  "5km E of Anchorage, AK",
  "near the east coast of Honshu, Japan",
  "Central Italy",
  "offshore Valparaiso, Chile",
);

const magnitudeArb = fc
  .double({ min: 0, max: 10, noNaN: true })
  // One decimal place keeps the printed message tidy and round-trippable.
  .map((m) => Math.round(m * 10) / 10);

/** Observation times anywhere in a broad past window (always before "now"). */
const timeMsArb = fc.integer({
  min: Date.parse("2020-01-01T00:00:00.000Z"),
  max: Date.parse("2024-12-31T00:00:00.000Z"),
});

const quakeArb: fc.Arbitrary<GeneratedQuake> = fc.record({
  // `us` + hex keeps ids URL-safe, newline-free, and easy to match in text.
  id: fc.hexaString({ minLength: 6, maxLength: 10 }).map((h) => `us${h}`),
  magnitude: magnitudeArb,
  place: placeArb,
  timeMs: timeMsArb,
});

/** 1..6 earthquakes with DISTINCT ids (deduped by id). */
const quakesArb = fc.uniqueArray(quakeArb, {
  minLength: 1,
  maxLength: 6,
  selector: (q) => q.id,
});

const scenarioArb: fc.Arbitrary<Scenario> = quakesArb.chain((quakes) =>
  fc.record({
    quakes: fc.constant(quakes),
    // The LLM may highlight any subset (possibly empty, possibly all).
    notable: fc.subarray(quakes),
    lastBriefingAtMs: fc.option(timeMsArb, { nil: null }),
  }),
);

// ---------------------------------------------------------------------------
// Scenario driver
// ---------------------------------------------------------------------------

/** Re-arm the S3 mock for one property iteration with the seeded snapshot. */
function primeS3(snapshot: Snapshot): void {
  s3Mock.reset();
  s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
  s3Mock.on(PutObjectCommand).resolves({});
  s3Mock
    .on(GetObjectCommand, { Key: sessionKey() })
    .resolves({ Body: streamBody(JSON.stringify(snapshot)) });
}

interface ScenarioRun {
  result: Awaited<ReturnType<typeof processBriefingEvent>>;
  model: CapturingToolModel;
  report: BriefingReport | undefined;
}

/**
 * Seed the snapshot, wire the fake model + report writer, and run the REAL
 * briefing path once for the generated scenario.
 */
async function runScenario(scenario: Scenario): Promise<ScenarioRun> {
  const { quakes, notable, lastBriefingAtMs } = scenario;

  primeS3(buildSnapshot(quakes, lastBriefingAtMs));

  const model = new CapturingToolModel({
    summary: "Synthesized summary of this period's seismic activity.",
    notableQuakes: notable.map((q) => ({
      earthquakeId: q.id,
      magnitude: q.magnitude,
      place: q.place,
      reason: "Notable for the reporting period.",
    })),
    geographicPatterns: "Clustering observed across the monitored regions.",
    comparisonToPrevious: "Activity comparable to the previous period.",
  });
  setModelForTesting(model);

  let report: BriefingReport | undefined;
  setReportWriterForTesting(
    async (_customerId, saved): Promise<ReportWriteResult> => {
      report = saved;
      return { statusCode: 201, body: "{}" };
    },
  );

  const result = await processBriefingEvent({
    customerId: CUSTOMER_ID,
    config: makeConfig(),
    event: makeEvent(),
  });

  return { result, model, report };
}

/** Extract the earthquake-observation ids the model saw on its first call. */
function observedQuakeIds(captured: Message[]): string[] {
  const ids: string[] = [];
  for (const message of captured) {
    if (message.role !== "user") {
      continue;
    }
    const text = messageText(message);
    if (!text.startsWith(EARTHQUAKE_MESSAGE_PREFIX)) {
      continue;
    }
    const match = /^- ID: (.+)$/m.exec(text);
    if (match) {
      ids.push(match[1]);
    }
  }
  return ids;
}

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
// Property 9
// ---------------------------------------------------------------------------

describe("Property 9: Briefing Report Completeness and Integrity", () => {
  it("11.1: the LLM sees every seeded earthquake observation plus the trigger message", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { result, model } = await runScenario(scenario);

        // A report was generated (the LLM was actually invoked).
        expect(result.status).toBe("generated");
        expect(model.calls.length).toBeGreaterThanOrEqual(1);

        const captured = model.calls[0];

        // The model saw EXACTLY the seeded earthquake observations — same set,
        // same count (no observation dropped, none duplicated/invented).
        const seenIds = observedQuakeIds(captured);
        const seededIds = scenario.quakes.map((q) => q.id);
        expect(seenIds.length).toBe(seededIds.length);
        expect(new Set(seenIds)).toEqual(new Set(seededIds));

        // The injected trigger message is present in the synthesized context.
        expect(
          captured.some(
            (m) =>
              m.role === "user" &&
              messageText(m).includes(BRIEFING_TRIGGER_MESSAGE),
          ),
        ).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("11.3/11.5: the saved report is complete and periodStart is strictly before periodEnd", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { result, report } = await runScenario(scenario);

        expect(result.status).toBe("generated");
        expect(report).toBeDefined();
        const saved = report!;

        // Req 11.5 — the reporting period is well-ordered.
        expect(Date.parse(saved.periodStart)).toBeLessThan(
          Date.parse(saved.periodEnd),
        );

        // Req 11.3 — all narrative fields are present and the count is faithful.
        expect(typeof saved.summary).toBe("string");
        expect(typeof saved.geographicPatterns).toBe("string");
        expect(typeof saved.comparisonToPrevious).toBe("string");
        expect(Array.isArray(saved.notableQuakes)).toBe(true);
        expect(saved.totalEarthquakes).toBe(scenario.quakes.length);
        expect(saved.customerId).toBe(CUSTOMER_ID);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("11.6: notableQuakes only reference earthquakes present in the conversation", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { result, report } = await runScenario(scenario);

        expect(result.status).toBe("generated");
        expect(report).toBeDefined();
        const saved = report!;

        const seededIds = new Set(scenario.quakes.map((q) => q.id));
        // Every highlighted quake references an earthquake actually observed.
        for (const notable of saved.notableQuakes) {
          expect(seededIds.has(notable.earthquakeId)).toBe(true);
        }
        // The host passes the LLM's chosen subset through faithfully (order and
        // identity preserved) — nothing added, nothing dropped.
        expect(saved.notableQuakes.map((q) => q.earthquakeId)).toEqual(
          scenario.notable.map((q) => q.id),
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
