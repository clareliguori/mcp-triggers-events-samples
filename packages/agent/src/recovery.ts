/**
 * Corrupted-session detection and recovery for the Serverless Agent
 * (task 9.10, Requirement 15.5, design Error Scenario 5).
 *
 * A customer's session is restored from the SDK snapshot key
 * `sessions/{customerId}/scopes/agent/agent/snapshots/snapshot_latest.json`
 * by the Strands SDK `SessionManager` during `agent.initialize()`. If that
 * object is corrupt — non-JSON bytes, or a structurally-wrong snapshot the SDK
 * refuses to load (wrong `scope`, unsupported `schemaVersion`) — the restore
 * throws and the agent cannot start. Per Error Scenario 5 the agent must then
 * **start fresh** (empty conversation history) and **archive** the corrupt
 * object to a `-corrupted` suffix key for debugging, rather than failing the
 * message forever.
 *
 * This module pre-flights that situation deterministically, *before* the agent
 * touches the session, so recovery does not depend on catching arbitrary errors
 * mid-processing:
 *
 * 1. {@link inspectSession} reads the snapshot object and classifies it as
 *    `missing` (no prior session — a normal first event), `valid` (parses and
 *    is a loadable agent snapshot), or `corrupted` (unparseable or not a
 *    loadable snapshot).
 * 2. {@link recoverCorruptedSession} archives the corrupt bytes to
 *    `<snapshot_latest.json>-corrupted-{timestamp}` (copy aside, then delete
 *    the original) so the next restore sees no session and starts fresh.
 *
 * The handler (task 9.10) calls {@link prepareSession} inside the per-customer
 * lock: if the session is corrupt it archives it (logging a warning with the
 * `customerId`) and proceeds with a fresh session; otherwise it is a no-op.
 * Because the corrupt object is moved aside, the subsequent
 * `processEarthquakeEvent` / `processBriefingEvent` restore finds nothing and
 * begins from an empty conversation (Requirement 15.5).
 *
 * All S3 access goes through {@link getS3Client} (from `accumulate.ts`), so the
 * existing `setS3ClientForTesting` seam covers this module too.
 */

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { SNAPSHOT_SCHEMA_VERSION, type Snapshot } from "@strands-agents/sdk";

import {
  getS3Client,
  isNotFoundError,
  sessionSnapshotKey,
  sessionsBucketName,
} from "./accumulate.js";

/** Classification of a customer's persisted session snapshot. */
export type SessionInspection =
  | { status: "missing" }
  | { status: "valid" }
  | { status: "corrupted"; reason: string };

/**
 * Minimal duck-typed check that a parsed value is a snapshot the SDK's
 * `agent.loadSnapshot` would accept: scope `'agent'` and the supported
 * `schemaVersion`. Mirrors the guard clauses in the SDK's `loadSnapshot` so a
 * snapshot that would throw on restore is classified `corrupted` here instead.
 */
function isLoadableAgentSnapshot(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<Snapshot> & { data?: unknown };
  if (candidate.scope !== "agent") {
    return false;
  }
  if (candidate.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    return false;
  }
  // A loadable snapshot carries a `data` object (the SDK reads
  // `messages`/`state`/... off it). Reject a missing or non-object `data`.
  return typeof candidate.data === "object" && candidate.data !== null;
}

/**
 * Inspect a customer's persisted session snapshot, classifying it so the
 * handler can recover a corrupt one before the agent attempts a restore.
 *
 * @returns
 * - `{ status: "missing" }` when there is no prior session (first event), so
 *   the agent will start fresh normally;
 * - `{ status: "valid" }` when the object parses and is a loadable agent
 *   snapshot;
 * - `{ status: "corrupted", reason }` when the object exists but is unparseable
 *   or is not a loadable snapshot (Requirement 15.5).
 *
 * @throws on a transient S3 read failure (not a 404), so the caller lets the
 *   SQS message retry rather than mistaking an outage for corruption.
 */
export async function inspectSession(
  customerId: string,
): Promise<SessionInspection> {
  const key = sessionSnapshotKey(customerId);

  let body: string | undefined;
  try {
    const result = await getS3Client().send(
      new GetObjectCommand({ Bucket: sessionsBucketName(), Key: key }),
    );
    body = await result.Body?.transformToString();
  } catch (error) {
    if (isNotFoundError(error)) {
      return { status: "missing" };
    }
    // Transient read failure — rethrow so the message retries.
    throw error;
  }

  if (body === undefined || body.length === 0) {
    // An empty object is unusable as a snapshot; treat it as corrupted so it
    // is archived and the agent starts fresh.
    return { status: "corrupted", reason: "empty session object" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return { status: "corrupted", reason: "session object is not valid JSON" };
  }

  if (!isLoadableAgentSnapshot(parsed)) {
    return {
      status: "corrupted",
      reason: "session object is not a loadable agent snapshot",
    };
  }

  return { status: "valid" };
}

/**
 * Archive a corrupt session object aside so the next restore starts fresh
 * (Requirement 15.5, design Error Scenario 5).
 *
 * The object is copied to a `-corrupted-{ISO timestamp}` suffix key (a unique,
 * non-clobbering name so repeated corruption is preserved for debugging) and
 * the original `snapshot_latest.json` is then deleted. Returns the archive key.
 */
export async function recoverCorruptedSession(
  customerId: string,
): Promise<string> {
  const bucket = sessionsBucketName();
  const sourceKey = sessionSnapshotKey(customerId);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveKey = `${sourceKey}-corrupted-${stamp}`;

  // Copy the corrupt bytes aside first so they survive for debugging even if
  // the subsequent delete fails. CopySource must be URL-encoded.
  await getS3Client().send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: encodeURIComponent(`${bucket}/${sourceKey}`),
      Key: archiveKey,
    }),
  );

  await getS3Client().send(
    new DeleteObjectCommand({ Bucket: bucket, Key: sourceKey }),
  );

  return archiveKey;
}

/** Outcome of {@link prepareSession}. */
export type SessionPreparation =
  | { status: "missing" }
  | { status: "valid" }
  | { status: "recovered"; archiveKey: string };

/**
 * Ensure the customer's session is safe to restore, recovering a corrupt one in
 * place (Requirement 15.5). Intended to run inside the per-customer lock, before
 * `processEarthquakeEvent` / `processBriefingEvent`.
 *
 * - `missing` / `valid`: no action; the caller proceeds normally.
 * - `corrupted`: the object is archived aside (logged with `customerId`) and
 *   `{ status: "recovered", archiveKey }` is returned; the caller then proceeds,
 *   and the subsequent restore finds no session and starts fresh.
 *
 * @throws on a transient S3 failure during inspection or archival, so the SQS
 *   message retries.
 */
export async function prepareSession(
  customerId: string,
): Promise<SessionPreparation> {
  const inspection = await inspectSession(customerId);
  if (inspection.status !== "corrupted") {
    return inspection;
  }

  console.warn("Recovering corrupted session; starting fresh", {
    customerId,
    reason: inspection.reason,
  });
  const archiveKey = await recoverCorruptedSession(customerId);
  return { status: "recovered", archiveKey };
}
