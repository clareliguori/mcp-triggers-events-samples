/**
 * Earthquake event processing for the Serverless Agent (task 9.4).
 *
 * The agent uses the **conversation history as the accumulator** — there is no
 * separate earthquake list. When an `earthquake.detected` event arrives, this
 * module:
 *
 * 1. Restores the customer's session from S3 (Strands SDK `SessionManager`
 *    backed by an S3 {@link SnapshotStorage}, sessionId = customerId, persisted
 *    at `sessions/{customerId}/session.json`) — Requirement 4.3/4.4.
 * 2. Performs an **idempotency check**: if the event's `eventId` is already in
 *    the session metadata, processing is skipped and success is returned so a
 *    duplicate SQS delivery never adds the same earthquake twice
 *    (Requirements 7.1, 7.2).
 * 3. Injects the earthquake data as a **user message** and invokes the LLM,
 *    which responds with analysis (significance, patterns relative to prior
 *    quakes already in the conversation) — Requirement 4.4.
 * 4. Persists the updated conversation history (user message + assistant
 *    response) and updated metadata back to S3 via the `SessionManager`
 *    (explicit save after a successful invocation) — Requirement 4.4.
 *
 * ## SDK API note (design vs. installed SDK)
 *
 * design.md (Component 4) assumes a `SessionManager` + `S3Storage` pair
 * exported by `@strands-agents/sdk`. The installed SDK (v1.3.0) does NOT export
 * an `S3Storage` class — persistence is snapshot-based through a pluggable
 * {@link SnapshotStorage} interface, with only a `FileStorage` implementation
 * shipped. This module therefore provides {@link S3SnapshotStorage}, a faithful
 * S3-backed `SnapshotStorage` that maps the mutable "latest" snapshot to the
 * `sessions/{customerId}/session.json` key the design and the Data API session
 * reader (task 4.6) expect. The persisted object is the SDK `Snapshot` shape
 * (`{ data: { messages, state, ... } }`), which the Data API reader already
 * understands (it reads `data.messages`).
 *
 * ## Testability
 *
 * The module exposes two test seams that mirror the conventions in `lock.ts`
 * and `router.ts` (module-level singletons with `setXForTesting` overrides):
 * - {@link setModelForTesting} swaps the Bedrock model for a fake so unit tests
 *   never call a real LLM, and
 * - {@link setS3ClientForTesting} swaps the S3 client so the real
 *   `Agent` + `SessionManager` + {@link S3SnapshotStorage} run against a mocked
 *   bucket.
 *
 * This lets the unit tests exercise the genuine restore -> idempotency ->
 * inject -> invoke -> persist path without AWS or model access.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
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
  Agent,
  BedrockModel,
  SessionManager,
  SNAPSHOT_SCHEMA_VERSION,
  type ConversationManager,
  type Model,
  type Snapshot,
  type SnapshotLocation,
  type SnapshotManifest,
  type SnapshotStorage,
  type ToolList,
} from "@strands-agents/sdk";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * appState key under which per-session metadata (idempotency bookkeeping,
 * activity counters) is stored. Kept out of the conversation history so it is
 * never sent to the model, but still captured in the session snapshot's
 * `data.state` and therefore persisted/restored across invocations.
 */
export const SESSION_METADATA_KEY = "sessionMetadata";

/**
 * Maximum number of recently-processed event IDs retained for the idempotency
 * check (a rolling window, mirroring the USGS cursor's bounded `lastSeenIds`).
 * With an expected load of 5-15 events/day/customer this comfortably covers any
 * realistic SQS redelivery window without growing the session unbounded.
 */
export const PROCESSED_EVENT_IDS_LIMIT = 200;

/**
 * Default Bedrock model id used when `BEDROCK_MODEL_ID` is not set in the
 * environment. The AgentStack does not yet wire a model id env var (task 9.10 /
 * CDK), so this default keeps the agent runnable; override it via the env var
 * without a code change.
 */
const DEFAULT_BEDROCK_MODEL_ID = "anthropic.claude-3-5-sonnet-20240620-v1:0";

/**
 * Resolve the sessions bucket name from the environment (set by AgentStack).
 *
 * Exported so the corrupted-session recovery path (task 9.10) archives the
 * corrupt object in the same bucket without duplicating the env lookup.
 */
export function sessionsBucketName(): string {
  const name = process.env.SESSIONS_BUCKET_NAME;
  if (!name) {
    // Misconfiguration — surfaces as a failed invocation so the message retries.
    throw new Error("SESSIONS_BUCKET_NAME is not set");
  }
  return name;
}

// ---------------------------------------------------------------------------
// Per-session metadata (idempotency + activity bookkeeping)
// ---------------------------------------------------------------------------

/**
 * Metadata persisted in the session's appState. A superset of the design's
 * {@link "@mcp-events/shared".AgentSessionMetadata} that additionally tracks a
 * bounded set of processed event IDs so duplicate deliveries are rejected
 * regardless of ordering (Requirements 7.1, 7.2).
 */
export interface SessionMetadata {
  /** Most recently processed event ID. */
  lastEventId: string;
  /** ISO 8601 timestamp of the last processed event. */
  lastActiveAt: string;
  /** Number of events processed for this customer. */
  invocationCount: number;
  /** ISO 8601 — when the last briefing was generated, or null if none yet. */
  lastBriefingAt: string | null;
  /** Cached from {@link CustomerConfig.displayName}. */
  customerDisplayName: string;
  /** Rolling window of processed event IDs for idempotency checks. */
  processedEventIds: string[];
}

/** A fresh metadata record for a session that has not processed any event yet. */
function emptyMetadata(displayName: string): SessionMetadata {
  return {
    lastEventId: "",
    lastActiveAt: "",
    invocationCount: 0,
    lastBriefingAt: null,
    customerDisplayName: displayName,
    processedEventIds: [],
  };
}

/**
 * Read the session metadata from the agent's restored appState, tolerating a
 * missing or partially-shaped record (e.g. a first-ever event or a session
 * written by an earlier version). Always returns a fully-populated, safe value.
 *
 * Exported so the briefing path (task 9.8) reads/updates the same metadata
 * record without duplicating the tolerant-parsing logic.
 */
export function readMetadata(
  agent: Agent,
  displayName: string,
): SessionMetadata {
  const raw = agent.appState.get(SESSION_METADATA_KEY);
  const base = emptyMetadata(displayName);
  if (raw === null || typeof raw !== "object") {
    return base;
  }
  const candidate = raw as Partial<SessionMetadata>;
  return {
    lastEventId:
      typeof candidate.lastEventId === "string"
        ? candidate.lastEventId
        : base.lastEventId,
    lastActiveAt:
      typeof candidate.lastActiveAt === "string"
        ? candidate.lastActiveAt
        : base.lastActiveAt,
    invocationCount:
      typeof candidate.invocationCount === "number"
        ? candidate.invocationCount
        : base.invocationCount,
    lastBriefingAt:
      typeof candidate.lastBriefingAt === "string"
        ? candidate.lastBriefingAt
        : base.lastBriefingAt,
    customerDisplayName:
      typeof candidate.customerDisplayName === "string"
        ? candidate.customerDisplayName
        : base.customerDisplayName,
    processedEventIds: Array.isArray(candidate.processedEventIds)
      ? candidate.processedEventIds.filter(
          (id): id is string => typeof id === "string",
        )
      : base.processedEventIds,
  };
}

/**
 * Persist the metadata back into the agent's appState (captured on save).
 *
 * Exported so the briefing path (task 9.8) writes the same metadata record
 * (e.g. stamping `lastBriefingAt`) through one code path.
 */
export function writeMetadata(agent: Agent, metadata: SessionMetadata): void {
  agent.appState.set(SESSION_METADATA_KEY, {
    ...metadata,
  });
}

/**
 * Advance the metadata to reflect that `eventId` was processed: bump counters,
 * stamp the activity time, and append the event to the bounded
 * `processedEventIds` window (oldest entries evicted past
 * {@link PROCESSED_EVENT_IDS_LIMIT}).
 *
 * Exported so the briefing path (task 9.8) records its `briefing.trigger`
 * eventId in the same bounded idempotency window used for earthquake events.
 */
export function recordProcessedEvent(
  metadata: SessionMetadata,
  eventId: string,
  displayName: string,
): SessionMetadata {
  const processedEventIds = [...metadata.processedEventIds, eventId];
  if (processedEventIds.length > PROCESSED_EVENT_IDS_LIMIT) {
    processedEventIds.splice(
      0,
      processedEventIds.length - PROCESSED_EVENT_IDS_LIMIT,
    );
  }
  return {
    ...metadata,
    lastEventId: eventId,
    lastActiveAt: new Date().toISOString(),
    invocationCount: metadata.invocationCount + 1,
    customerDisplayName: displayName,
    processedEventIds,
  };
}

// ---------------------------------------------------------------------------
// S3-backed SnapshotStorage
// ---------------------------------------------------------------------------

/** Lazily-created S3 client, reused across warm invocations. */
let s3Client: S3Client | undefined;

/**
 * Return the shared {@link S3Client}, creating it on first use.
 *
 * Exported so the corrupted-session recovery path (task 9.10) archives the
 * corrupt object through the same client (and therefore the same
 * {@link setS3ClientForTesting} test seam) the agent's storage uses.
 */
export function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({});
  }
  return s3Client;
}

/**
 * The S3 object key holding a customer's mutable "latest" session snapshot,
 * `sessions/{customerId}/session.json`. This is the canonical session file the
 * design, the Data API session reader (task 4.6), and {@link S3SnapshotStorage}
 * all agree on. Exported so the corrupted-session recovery path (task 9.10)
 * inspects and archives exactly this object.
 */
export function sessionSnapshotKey(customerId: string): string {
  return `sessions/${customerId}/session.json`;
}

/**
 * Override the S3 client. Test seam only — production code never calls this.
 * Pass `undefined` to reset back to the lazily-created client.
 */
export function setS3ClientForTesting(client: S3Client | undefined): void {
  s3Client = client;
}

/** True when an S3 error represents a missing object/bucket or a 404 response. */
export function isNotFoundError(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const candidate = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  if (
    typeof candidate.name === "string" &&
    (candidate.name === "NoSuchKey" || candidate.name === "NoSuchBucket")
  ) {
    return true;
  }
  return candidate.$metadata?.httpStatusCode === 404;
}

/**
 * S3-backed implementation of the Strands SDK {@link SnapshotStorage} interface.
 *
 * Key layout (per customer session, keyed purely on `sessionId` = `customerId`
 * since each customer has exactly one agent scope):
 * ```
 * sessions/<customerId>/session.json                  // mutable "latest" snapshot
 * sessions/<customerId>/history/snapshot_<id>.json     // immutable checkpoints
 * sessions/<customerId>/manifest.json                  // snapshot manifest
 * ```
 *
 * The "latest" snapshot lives at `session.json` so it matches the path the
 * design and the Data API read-only session endpoint (task 4.6) expect; the
 * agent's default `saveLatestOn: 'invocation'` strategy means this is the only
 * object written during normal earthquake processing.
 */
export class S3SnapshotStorage implements SnapshotStorage {
  constructor(private readonly bucket: string) {}

  /** Prefix for all of a session's objects. */
  private sessionPrefix(sessionId: string): string {
    return `sessions/${sessionId}/`;
  }

  /** Key for the mutable "latest" snapshot (the canonical session file). */
  private latestKey(sessionId: string): string {
    return `${this.sessionPrefix(sessionId)}session.json`;
  }

  /** Key for an immutable checkpoint snapshot. */
  private historyKey(sessionId: string, snapshotId: string): string {
    return `${this.sessionPrefix(sessionId)}history/snapshot_${snapshotId}.json`;
  }

  /** Key for the snapshot manifest. */
  private manifestKey(sessionId: string): string {
    return `${this.sessionPrefix(sessionId)}manifest.json`;
  }

  /** Resolve the object key for a save/load, branching on latest vs. history. */
  private snapshotKey(
    location: SnapshotLocation,
    snapshotId: string | undefined,
    isLatest: boolean,
  ): string {
    if (isLatest || snapshotId === undefined || snapshotId === "latest") {
      return this.latestKey(location.sessionId);
    }
    return this.historyKey(location.sessionId, snapshotId);
  }

  /** Read and JSON-parse an object, returning null when it does not exist. */
  private async getJson<T>(key: string): Promise<T | null> {
    let body: string | undefined;
    try {
      const result = await getS3Client().send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      body = await result.Body?.transformToString();
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
    if (!body) {
      return null;
    }
    return JSON.parse(body) as T;
  }

  /** Serialize and write an object as JSON. */
  private async putJson(key: string, value: unknown): Promise<void> {
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(value),
        ContentType: "application/json",
      }),
    );
  }

  async saveSnapshot(params: {
    location: SnapshotLocation;
    snapshotId: string;
    isLatest: boolean;
    snapshot: Snapshot;
  }): Promise<void> {
    const key = this.snapshotKey(
      params.location,
      params.snapshotId,
      params.isLatest,
    );
    await this.putJson(key, params.snapshot);
  }

  async loadSnapshot(params: {
    location: SnapshotLocation;
    snapshotId?: string;
  }): Promise<Snapshot | null> {
    const key = this.snapshotKey(
      params.location,
      params.snapshotId,
      params.snapshotId === undefined,
    );
    return this.getJson<Snapshot>(key);
  }

  async listSnapshotIds(params: {
    location: SnapshotLocation;
    limit?: number;
    startAfter?: string;
  }): Promise<string[]> {
    const prefix = `${this.sessionPrefix(params.location.sessionId)}history/snapshot_`;
    const result = await getS3Client().send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ...(params.limit !== undefined && { MaxKeys: params.limit }),
      }),
    );
    const ids = (result.Contents ?? [])
      .map((object) => object.Key)
      .filter((key): key is string => typeof key === "string")
      .map((key) => key.slice(prefix.length).replace(/\.json$/, ""))
      .filter((id) => id.length > 0)
      // Snapshot IDs are UUID v7, so lexicographic order is chronological.
      .sort();
    const filtered =
      params.startAfter !== undefined
        ? ids.filter((id) => id > params.startAfter!)
        : ids;
    return params.limit !== undefined
      ? filtered.slice(0, params.limit)
      : filtered;
  }

  async deleteSession(params: { sessionId: string }): Promise<void> {
    const prefix = this.sessionPrefix(params.sessionId);
    const listing = await getS3Client().send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix }),
    );
    const keys = (listing.Contents ?? [])
      .map((object) => object.Key)
      .filter((key): key is string => typeof key === "string");
    await Promise.all(
      keys.map((key) =>
        getS3Client().send(
          new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
        ),
      ),
    );
  }

  async loadManifest(params: {
    location: SnapshotLocation;
  }): Promise<SnapshotManifest> {
    const manifest = await this.getJson<SnapshotManifest>(
      this.manifestKey(params.location.sessionId),
    );
    return (
      manifest ?? {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
      }
    );
  }

  async saveManifest(params: {
    location: SnapshotLocation;
    manifest: SnapshotManifest;
  }): Promise<void> {
    await this.putJson(
      this.manifestKey(params.location.sessionId),
      params.manifest,
    );
  }
}

// ---------------------------------------------------------------------------
// Model (test seam)
// ---------------------------------------------------------------------------

/** Module-level model override for tests. */
let modelOverride: Model | undefined;

/**
 * Override the LLM model. Test seam only — production code never calls this.
 * Pass `undefined` to reset back to the default {@link BedrockModel}.
 */
export function setModelForTesting(model: Model | undefined): void {
  modelOverride = model;
}

/** Resolve the model to use: the test override, or a default {@link BedrockModel}. */
function resolveModel(): Model {
  if (modelOverride) {
    return modelOverride;
  }
  const modelId = process.env.BEDROCK_MODEL_ID ?? DEFAULT_BEDROCK_MODEL_ID;
  return new BedrockModel({ modelId });
}

// ---------------------------------------------------------------------------
// Agent construction
// ---------------------------------------------------------------------------

/** Options for {@link buildAgent}. */
export interface BuildAgentOptions {
  /**
   * Tools to register on the agent. The earthquake path (task 9.4) passes
   * none; the briefing path (task 9.8) passes the `save_report` tool so the
   * LLM can persist its synthesized report.
   */
  tools?: ToolList;
  /**
   * Conversation manager controlling history retention. Defaults to the SDK's
   * sliding-window manager (the earthquake path's behavior). The briefing path
   * passes a {@link NullConversationManager} so the LLM sees **all** prior
   * earthquake observations when synthesizing the report (Requirement 11.1)
   * rather than a truncated window.
   */
  conversationManager?: ConversationManager;
}

/**
 * Build a Strands {@link Agent} for a customer, wired to persist its session at
 * `sessions/{customerId}/session.json` via the S3-backed
 * {@link S3SnapshotStorage}. The customer's `briefingPrompt` is used as the
 * system prompt (it guides both earthquake analysis and, later, briefing
 * synthesis — Requirement 11.2).
 *
 * @param customerId    the customer whose session to bind (sessionId).
 * @param systemPrompt  the customer's `briefingPrompt`.
 * @param options       optional tools / conversation manager (see
 *   {@link BuildAgentOptions}).
 */
export function buildAgent(
  customerId: string,
  systemPrompt: string,
  options: BuildAgentOptions = {},
): Agent {
  const sessionManager = new SessionManager({
    sessionId: customerId,
    storage: { snapshot: new S3SnapshotStorage(sessionsBucketName()) },
    // Disable auto-save: we persist explicitly after a successful LLM
    // invocation (see processEarthquakeEvent). This gives deterministic
    // persist-on-success semantics so a failed invocation leaves the session
    // untouched and the SQS message can safely retry (Requirement 15.2).
    saveLatestOn: "trigger",
  });

  return new Agent({
    model: resolveModel(),
    systemPrompt,
    sessionManager,
    ...(options.tools !== undefined && { tools: options.tools }),
    ...(options.conversationManager !== undefined && {
      conversationManager: options.conversationManager,
    }),
    // The agent runs headless in Lambda; no console output.
    printer: false,
  });
}

// ---------------------------------------------------------------------------
// Earthquake user-message formatting
// ---------------------------------------------------------------------------

/**
 * Leading line of an earthquake observation user message. Exported so the
 * briefing path (task 9.8) can recognize earthquake observations already in the
 * conversation history (to count them for the report and to guard against
 * generating an empty briefing) without re-implementing the format.
 */
export const EARTHQUAKE_MESSAGE_PREFIX = "A new earthquake has been detected:";

/**
 * Render an {@link EarthquakeDetectedData} payload as a human-readable user
 * message for the LLM. The message states the new earthquake's salient facts
 * and asks for a brief in-context analysis, so the assistant's response (and
 * thus the growing conversation history) accumulates per-quake analysis the
 * later briefing can synthesize (Requirement 4.4).
 */
export function formatEarthquakeUserMessage(
  data: EarthquakeDetectedData,
): string {
  const { coordinates } = data;
  const felt = data.felt === null ? "no reports" : `${data.felt} reports`;
  const alert = data.alert ?? "none";
  return [
    EARTHQUAKE_MESSAGE_PREFIX,
    `- ID: ${data.earthquakeId}`,
    `- Magnitude: ${data.magnitude}`,
    `- Location: ${data.place}`,
    `- Time: ${data.time}`,
    `- Coordinates: ${coordinates.latitude}, ${coordinates.longitude}`,
    `- Depth: ${coordinates.depth} km`,
    `- Tsunami warning: ${data.tsunami ? "yes" : "no"}`,
    `- Felt: ${felt}`,
    `- PAGER alert level: ${alert}`,
    `- More info: ${data.url}`,
    "",
    "Briefly analyze this earthquake's significance and how it relates to any earlier earthquakes in our conversation.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Earthquake event processing
// ---------------------------------------------------------------------------

/** Input for {@link processEarthquakeEvent}. */
export interface EarthquakeEventContext {
  /** Customer resolved from the subscription (see `router.ts`). */
  customerId: string;
  /** Customer configuration loaded from the Data API (briefingPrompt, etc.). */
  config: CustomerConfig;
  /** The validated `earthquake.detected` MCP event payload. */
  event: McpEventPayload<EarthquakeDetectedData>;
}

/** Outcome of processing a single earthquake event. */
export type EarthquakeProcessingResult =
  | {
      /** The event was analyzed by the LLM and the session persisted. */
      status: "processed";
      customerId: string;
      eventId: string;
      /** The assistant's analysis text. */
      analysis: string;
    }
  | {
      /** The event was a duplicate; processing skipped (Requirements 7.1, 7.2). */
      status: "skipped";
      customerId: string;
      eventId: string;
    };

/**
 * Process an `earthquake.detected` event for a customer (Requirements 4.4,
 * 7.1, 7.2).
 *
 * Flow:
 * 1. Build the customer's agent and restore its session from S3 (via
 *    `agent.initialize()`, which fires the SessionManager's restore hook).
 * 2. Re-apply the current `briefingPrompt` as the system prompt so a config
 *    update takes effect even though the restored snapshot carries the prior
 *    prompt.
 * 3. **Idempotency check** — if `eventId` is already recorded in the session
 *    metadata, skip and return `{ status: "skipped" }` without mutating the
 *    session (Requirement 7.1) so a redelivered event never adds a duplicate
 *    user message (Requirement 7.2).
 * 4. Record the event in the metadata, inject the earthquake as a user message,
 *    and invoke the LLM. After the invocation succeeds, the updated
 *    conversation history + metadata are saved to
 *    `sessions/{customerId}/session.json` (Requirement 4.4).
 *
 * This function assumes the caller already holds the per-customer distributed
 * lock (task 9.1 / handler task 9.10), so the read-modify-write of the session
 * is serialized.
 *
 * @throws when session restore or the LLM invocation fails; the caller lets the
 *   SQS message return to the queue for retry. Because nothing is persisted on
 *   the failure path, the retry safely reprocesses the event.
 */
export async function processEarthquakeEvent(
  ctx: EarthquakeEventContext,
): Promise<EarthquakeProcessingResult> {
  const { customerId, config, event } = ctx;

  const agent = buildAgent(customerId, config.briefingPrompt);

  // Restore the prior session (conversation history + metadata) from S3 before
  // any decision is made (Requirement 4.3). initialize() is idempotent and is
  // also called by invoke(), but we need the restored state up front for the
  // idempotency check below.
  await agent.initialize();

  // The restored snapshot carries the system prompt that was in effect when it
  // was written; re-apply the current briefingPrompt so config updates take
  // effect immediately and are persisted on the next save (Requirement 11.2).
  agent.systemPrompt = config.briefingPrompt;

  const metadata = readMetadata(agent, config.displayName);

  // Idempotency: a duplicate delivery of an already-processed event is a no-op
  // that returns success, leaving the conversation history untouched
  // (Requirements 7.1, 7.2).
  if (metadata.processedEventIds.includes(event.eventId)) {
    return { status: "skipped", customerId, eventId: event.eventId };
  }

  // Record the event in the metadata BEFORE invoking the LLM so the snapshot
  // auto-saved after the invocation captures the updated idempotency window.
  writeMetadata(
    agent,
    recordProcessedEvent(metadata, event.eventId, config.displayName),
  );

  // Inject the earthquake as a user message and invoke the LLM. The agent
  // appends both the user message and the assistant's analysis to the
  // conversation history.
  const userMessage = formatEarthquakeUserMessage(event.data);
  const result = await agent.invoke(userMessage);

  // Persist the updated conversation history + metadata to
  // `sessions/{customerId}/session.json` only after a successful invocation
  // (Requirement 4.4). Auto-save is disabled (saveLatestOn: 'trigger'), so a
  // failed invocation above leaves the session untouched and the SQS message
  // can retry without double-recording the event.
  if (agent.sessionManager) {
    await agent.sessionManager.saveSnapshot({ target: agent, isLatest: true });
  }

  return {
    status: "processed",
    customerId,
    eventId: event.eventId,
    analysis: result.toString(),
  };
}
