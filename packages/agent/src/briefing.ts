/**
 * Briefing trigger processing for the Serverless Agent (task 9.8).
 *
 * When a `briefing.trigger` event arrives, the customer's session already holds
 * every earthquake observation as conversation history (task 9.4 — the
 * conversation history IS the accumulator). This module synthesizes that
 * history into a {@link BriefingReport} (Requirements 4.5, 4.6, 11.x):
 *
 * 1. Restore the customer's session from S3 (Strands SDK `SessionManager`
 *    backed by the SDK's official {@link S3Storage}, sessionId = customerId)
 *    and re-apply the customer's `briefingPrompt` as the system prompt
 *    (Requirement 11.2).
 * 2. **Idempotency / empty-report guards** (Requirements 7.1, 7.3):
 *    - if the trigger's `eventId` was already processed, skip; and
 *    - if the conversation holds **no** earthquake observations, skip without
 *      invoking the LLM so we never persist an empty/meaningless report.
 * 3. Inject the trigger user message ("Generate your periodic briefing report
 *    now.") and invoke the LLM with the **full** conversation history. The LLM
 *    synthesizes everything in context and calls the {@link makeSaveReportTool}
 *    `save_report` tool (Requirements 4.5, 11.1, 11.4).
 * 4. The `save_report` callback assembles the full report — the **host** owns
 *    the deterministic fields (`reportId`, `customerId`, `periodStart` <
 *    `periodEnd`, `totalEarthquakes`, timestamps; Requirements 11.3, 11.5) and
 *    the LLM supplies the narrative fields — and POSTs it to the Data API
 *    (`POST /customers/{customerId}/reports`) over IAM SigV4 (Requirement
 *    11.4, 17.7).
 * 5. Persist the updated session (Requirement 4.6). See
 *    {@link CLEAR_CONVERSATION_AFTER_BRIEFING} for the context-window strategy.
 *
 * ## Context-window management strategy (Requirement 4.6)
 *
 * After a report is saved this module **clears** the conversation history,
 * retaining only the session metadata (with `lastBriefingAt` stamped). This is
 * a deliberate choice:
 *
 * - **Bounded growth.** The agent runs indefinitely; without clearing, every
 *   earthquake observation would accumulate forever and eventually overflow the
 *   model's context window. Clearing at each briefing bounds the session to one
 *   briefing period's worth of observations.
 * - **Clean period boundaries.** Each briefing then covers exactly the
 *   earthquakes observed since the previous briefing, so `periodStart`
 *   (= `lastBriefingAt`) → `periodEnd` (= now) is precise.
 * - **Natural duplicate/empty protection.** A re-fired `briefing.trigger` after
 *   a briefing finds an empty conversation, counts zero observations, and is
 *   skipped — directly satisfying Requirement 7.3 without extra bookkeeping.
 *
 * The persisted report in S3 is the durable artifact; the conversation is only
 * the working accumulator, so clearing it loses nothing the customer can see.
 *
 * ## Testability
 *
 * Reuses the same test seams as `accumulate.ts` ({@link setModelForTesting},
 * {@link setS3ClientForTesting}) plus a Data API seam ({@link
 * setReportWriterForTesting}) mirroring `router.ts`'s lookup seam, so unit
 * tests run the real Agent + SessionManager + S3Storage against a fake
 * model (simulating the `save_report` tool call), mocked S3, and a mocked Data
 * API — with no AWS or LLM access.
 */

import { randomUUID } from "node:crypto";

import type {
  BriefingReport,
  BriefingTriggerData,
  CustomerConfig,
  McpEventPayload,
  NotableQuake,
} from "@mcp-events/shared";
import { briefingReportSchema } from "@mcp-events/shared";
import {
  SlidingWindowConversationManager,
  tool,
  type Agent,
  type JSONValue,
  type Message,
} from "@strands-agents/sdk";
import { z } from "zod";

import {
  EARTHQUAKE_MESSAGE_PREFIX,
  CONVERSATION_WINDOW_SIZE,
  buildAgent,
  readMetadata,
  recordProcessedEvent,
  writeMetadata,
  type SessionMetadata,
} from "./accumulate.js";
import { signedFetch } from "./sigv4.js";
import { withTimeout } from "./timeout.js";

/**
 * Whether to clear the conversation history after a briefing is saved. See the
 * module-level "Context-window management strategy" note for the rationale.
 * Exposed as a named constant so the decision is explicit and discoverable.
 */
export const CLEAR_CONVERSATION_AFTER_BRIEFING = true;

/** The trigger message injected to prompt briefing synthesis (Requirement 4.5). */
export const BRIEFING_TRIGGER_MESSAGE =
  "Generate your periodic briefing report now.";

// ---------------------------------------------------------------------------
// Data API report writer (IAM SigV4) — test seam
// ---------------------------------------------------------------------------

/** Outcome of a Data API report write: downstream status and raw body. */
export interface ReportWriteResult {
  /** Downstream HTTP status code from the Data API. */
  statusCode: number;
  /** Raw response body text (may be empty). */
  body: string;
}

/**
 * Persists a {@link BriefingReport} to the Data API. The production
 * implementation SigV4-signs `POST /customers/{customerId}/reports`; tests
 * override it via {@link setReportWriterForTesting} so they never sign or hit
 * the network.
 */
export type ReportWriter = (
  customerId: string,
  report: BriefingReport,
) => Promise<ReportWriteResult>;

/** Resolve the Data API base URL from the environment (set by AgentStack). */
function dataApiUrl(): string {
  const url = process.env.DATA_API_URL;
  if (!url) {
    // Misconfiguration — surfaces as a thrown error so the message retries.
    throw new Error("DATA_API_URL is not set");
  }
  return url;
}

/**
 * SigV4-sign `POST {DATA_API_URL}/customers/{customerId}/reports` and deliver
 * it with the shared {@link signedFetch} helper. The Data API validates the
 * body, writes it to `reports/{customerId}/{reportId}.json`, and returns
 * `{ reportId }` (Requirements 9.6, 11.4, 17.7).
 */
const defaultReportWriter: ReportWriter = async (customerId, report) => {
  const baseUrl = dataApiUrl().replace(/\/+$/, "");
  const target = `${baseUrl}/customers/${encodeURIComponent(customerId)}/reports`;

  return signedFetch({
    method: "POST",
    url: target,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(report),
  });
};

/** Module-level report writer singleton (test seam). */
let reportWriter: ReportWriter = defaultReportWriter;

/**
 * Override the Data API {@link ReportWriter}. Test seam only — production code
 * never calls this. Pass `undefined` to reset back to the default SigV4
 * implementation.
 */
export function setReportWriterForTesting(
  override: ReportWriter | undefined,
): void {
  reportWriter = override ?? defaultReportWriter;
}

// ---------------------------------------------------------------------------
// Conversation inspection (the accumulator)
// ---------------------------------------------------------------------------

/** Concatenate the text content of a {@link Message} into a single string. */
function messageText(message: Message): string {
  const blocks = message.content as unknown as { text?: unknown }[];
  return blocks
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .join("\n");
}

/**
 * Find every earthquake observation in the conversation history. An observation
 * is a user message rendered by `formatEarthquakeUserMessage` (task 9.4), which
 * always begins with {@link EARTHQUAKE_MESSAGE_PREFIX}. Returns each one's
 * parsed occurrence time (from the `- Time:` line) when available.
 */
function findEarthquakeObservations(agent: Agent): { time: string | null }[] {
  const observations: { time: string | null }[] = [];
  for (const message of agent.messages) {
    if (message.role !== "user") {
      continue;
    }
    const text = messageText(message);
    if (!text.startsWith(EARTHQUAKE_MESSAGE_PREFIX)) {
      continue;
    }
    const match = /^- Time: (.+)$/m.exec(text);
    observations.push({ time: match ? match[1] : null });
  }
  return observations;
}

/**
 * Compute the bounded reporting period for the briefing.
 *
 * `periodEnd` is the briefing generation time. `periodStart` is the previous
 * briefing time (`lastBriefingAt`) when present, otherwise the earliest
 * earthquake observation time in the conversation. The result is guaranteed to
 * satisfy `periodStart < periodEnd` (Requirement 11.5): on the rare chance the
 * computed start is not strictly before the end (clock skew, unparseable
 * times), it is floored to one second before `periodEnd`.
 */
function computePeriod(
  observations: { time: string | null }[],
  lastBriefingAt: string | null,
  periodEnd: string,
): { periodStart: string; periodEnd: string } {
  const periodEndMs = Date.parse(periodEnd);

  const observationTimesMs = observations
    .map((o) => (o.time === null ? NaN : Date.parse(o.time)))
    .filter((ms) => Number.isFinite(ms));
  const earliestObservationMs =
    observationTimesMs.length > 0 ? Math.min(...observationTimesMs) : NaN;

  let periodStartMs = lastBriefingAt
    ? Date.parse(lastBriefingAt)
    : earliestObservationMs;

  if (!Number.isFinite(periodStartMs) || periodStartMs >= periodEndMs) {
    // Safe floor: always strictly before periodEnd (Requirement 11.5).
    periodStartMs = periodEndMs - 1000;
  }

  return {
    periodStart: new Date(periodStartMs).toISOString(),
    periodEnd,
  };
}

// ---------------------------------------------------------------------------
// save_report tool
// ---------------------------------------------------------------------------

/**
 * Narrative fields the LLM supplies to `save_report`. The deterministic fields
 * (ids, timestamps, period bounds, totals) are owned by the host and merged in
 * by the tool callback — they are never trusted to the model.
 */
const saveReportInputSchema = z.object({
  summary: z.string().describe("High-level summary of seismic activity"),
  notableQuakes: z
    .array(
      z.object({
        earthquakeId: z.string(),
        magnitude: z.number(),
        place: z.string(),
        reason: z.string().describe("Why this quake is notable"),
      }),
    )
    .describe("Significant earthquakes to highlight"),
  geographicPatterns: z.string().describe("Analysis of geographic clustering"),
  comparisonToPrevious: z
    .string()
    .describe("How this period compares to the last"),
});

/** Host-owned context the `save_report` callback needs to assemble a report. */
interface SaveReportContext {
  customerId: string;
  config: CustomerConfig;
  periodStart: string;
  periodEnd: string;
  totalEarthquakes: number;
}

/**
 * Mutable record of what the `save_report` tool did during an invocation, so
 * the caller can tell whether a report was actually saved and react to a Data
 * API failure (the tool itself cannot abort the agent loop).
 */
interface SaveReportOutcome {
  /** Set to the persisted report id on a successful save. */
  reportId?: string;
  /** Set to a human-readable reason when the save failed. */
  error?: string;
}

/**
 * Build the `save_report` tool bound to this invocation's host context and
 * outcome recorder. The callback merges the LLM's narrative fields with the
 * host-owned deterministic fields, validates the full {@link BriefingReport}
 * against the shared schema, and POSTs it to the Data API (Requirement 11.4).
 *
 * On a Data API failure the callback records the error and returns an error
 * message to the model rather than throwing — the caller inspects
 * {@link SaveReportOutcome} after the invocation and fails the whole briefing
 * (for SQS retry) when no report was saved.
 */
function makeSaveReportTool(
  ctx: SaveReportContext,
  outcome: SaveReportOutcome,
) {
  return tool({
    name: "save_report",
    description:
      "Save the generated earthquake briefing report. Call this exactly once when generating a periodic briefing.",
    inputSchema: saveReportInputSchema,
    callback: async (input): Promise<Record<string, JSONValue>> => {
      const reportId = randomUUID();
      const notableQuakes: NotableQuake[] = input.notableQuakes.map((q) => ({
        earthquakeId: q.earthquakeId,
        magnitude: q.magnitude,
        place: q.place,
        reason: q.reason,
      }));

      const report: BriefingReport = {
        reportId,
        customerId: ctx.customerId,
        customerDisplayName: ctx.config.displayName,
        briefingPrompt: ctx.config.briefingPrompt,
        generatedAt: ctx.periodEnd,
        periodStart: ctx.periodStart,
        periodEnd: ctx.periodEnd,
        summary: input.summary,
        totalEarthquakes: ctx.totalEarthquakes,
        notableQuakes,
        geographicPatterns: input.geographicPatterns,
        comparisonToPrevious: input.comparisonToPrevious,
      };

      // Validate locally before the network call so a malformed report fails
      // fast with a clear message (the Data API also validates — Requirement
      // 11.5 periodStart < periodEnd is enforced by this schema).
      const parsed = briefingReportSchema.safeParse(report);
      if (!parsed.success) {
        outcome.error = `assembled report is invalid: ${parsed.error.issues
          .map((i) => i.message)
          .join("; ")}`;
        return { saved: false, error: outcome.error };
      }

      const result = await reportWriter(ctx.customerId, report);
      if (result.statusCode < 200 || result.statusCode >= 300) {
        outcome.error = `Data API report write returned ${result.statusCode}`;
        return { saved: false, error: outcome.error };
      }

      outcome.reportId = reportId;
      return { saved: true, reportId };
    },
  });
}

// ---------------------------------------------------------------------------
// Briefing processing
// ---------------------------------------------------------------------------

/** Input for {@link processBriefingEvent}. */
export interface BriefingEventContext {
  /** Customer resolved from the subscription (see `router.ts`). */
  customerId: string;
  /** Customer configuration loaded from the Data API (briefingPrompt, etc.). */
  config: CustomerConfig;
  /** The validated `briefing.trigger` MCP event payload. */
  event: McpEventPayload<BriefingTriggerData>;
}

/** Outcome of processing a single briefing trigger. */
export type BriefingProcessingResult =
  | {
      /** A report was synthesized, saved via the Data API, and session persisted. */
      status: "generated";
      customerId: string;
      eventId: string;
      reportId: string;
    }
  | {
      /** Processing was skipped; the session was left untouched. */
      status: "skipped";
      /**
       * `duplicate`    — the trigger's eventId was already processed (7.1).
       * `no-activity`  — no earthquake observations to report on (7.3, avoids
       *                  an empty report).
       */
      reason: "duplicate" | "no-activity";
      customerId: string;
      eventId: string;
    };

/**
 * Process a `briefing.trigger` event for a customer (Requirements 4.5, 4.6,
 * 11.x, 7.1, 7.3).
 *
 * Assumes the caller already holds the per-customer distributed lock (task
 * 9.1 / handler task 9.10) so the read-modify-write of the session is
 * serialized.
 *
 * @throws when session restore or the LLM invocation fails, or when the LLM
 *   does not save a report (Data API failure, or the model never called
 *   `save_report`). Because nothing is persisted on these paths, the SQS
 *   message can safely retry.
 */
export async function processBriefingEvent(
  ctx: BriefingEventContext,
): Promise<BriefingProcessingResult> {
  const { customerId, config, event } = ctx;

  const outcome: SaveReportOutcome = {};

  // The save_report tool needs the period + totals, which depend on the
  // restored conversation. Build the agent first with a placeholder context
  // object that is populated after restore but before invocation.
  const saveReportCtx: SaveReportContext = {
    customerId,
    config,
    periodStart: "",
    periodEnd: "",
    totalEarthquakes: 0,
  };

  const agent = buildAgent(customerId, config.briefingPrompt, {
    tools: [makeSaveReportTool(saveReportCtx, outcome)],
    // Use a window large enough to synthesize a meaningful report but bounded
    // to stay within the model's 200K token context window.
    conversationManager: new SlidingWindowConversationManager({
      windowSize: CONVERSATION_WINDOW_SIZE,
    }),
  });

  // Restore the prior session (conversation history + metadata) from S3
  // (Requirement 4.3).
  await agent.initialize();

  // Re-apply the current briefingPrompt as the system prompt so a config
  // update takes effect even though the restored snapshot carries the prior
  // prompt (Requirement 11.2).
  agent.systemPrompt = config.briefingPrompt;

  const metadata = readMetadata(agent, config.displayName);

  // Idempotency: a duplicate delivery of an already-processed trigger is a
  // no-op (Requirement 7.1).
  if (metadata.processedEventIds.includes(event.eventId)) {
    return {
      status: "skipped",
      reason: "duplicate",
      customerId,
      eventId: event.eventId,
    };
  }

  // Empty-report guard: with no earthquake observations to synthesize, skip
  // without invoking the LLM so we never persist an empty/meaningless report
  // (Requirement 7.3). Clearing the conversation after each briefing means a
  // re-fired trigger naturally lands here.
  const observations = findEarthquakeObservations(agent);
  if (observations.length === 0) {
    return {
      status: "skipped",
      reason: "no-activity",
      customerId,
      eventId: event.eventId,
    };
  }

  // Populate the host-owned report fields now that the conversation is known.
  const periodEnd = new Date().toISOString();
  const { periodStart } = computePeriod(
    observations,
    metadata.lastBriefingAt,
    periodEnd,
  );
  saveReportCtx.periodStart = periodStart;
  saveReportCtx.periodEnd = periodEnd;
  saveReportCtx.totalEarthquakes = observations.length;

  // Inject the trigger message and invoke the LLM with the full conversation
  // history. The LLM synthesizes everything in context and calls save_report
  // (Requirements 4.5, 11.1, 11.4).
  await withTimeout(
    agent.invoke(BRIEFING_TRIGGER_MESSAGE),
    90_000,
    `Bedrock briefing invoke timed out for customer ${customerId}`,
  );

  // The tool callback cannot abort the agent loop, so a missing report id here
  // means either the Data API write failed or the model never called the tool.
  // Treat both as a retryable failure: nothing was persisted to the session,
  // so the SQS message can safely reprocess (Requirement 15.2).
  if (outcome.reportId === undefined) {
    throw new Error(
      outcome.error ??
        `Briefing for customer ${customerId} did not produce a saved report`,
    );
  }

  // Record the trigger in the idempotency window and stamp the briefing time
  // (Requirement 7.1, observability).
  const updated: SessionMetadata = {
    ...recordProcessedEvent(metadata, event.eventId, config.displayName),
    lastBriefingAt: periodEnd,
  };
  writeMetadata(agent, updated);

  // Context-window management (Requirement 4.6): clear the working accumulator
  // now that the durable report is saved. See the module-level note.
  if (CLEAR_CONVERSATION_AFTER_BRIEFING) {
    agent.messages.length = 0;
  }

  // Persist the updated session (cleared conversation + updated metadata) to
  // the SDK snapshot key
  // sessions/{customerId}/scopes/agent/agent/snapshots/snapshot_latest.json
  // (Requirement 4.6).
  if (agent.sessionManager) {
    await agent.sessionManager.saveSnapshot({ target: agent, isLatest: true });
  }

  return {
    status: "generated",
    customerId,
    eventId: event.eventId,
    reportId: outcome.reportId,
  };
}
