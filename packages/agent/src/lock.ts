/**
 * Distributed session lock for the Serverless Agent (task 9.1).
 *
 * Concurrent SQS deliveries for the same customer must not corrupt that
 * customer's session state, so every read-modify-write of a session is
 * serialized behind a per-customer distributed lock (Requirements 6.1, 6.2).
 * Rather than hand-roll the conditional-write / TTL machinery, the agent uses
 * the `@deliveryhero/dynamodb-lock` client backed by the AgentStack session
 * locks DynamoDB table.
 *
 * Library API note: the installed `@deliveryhero/dynamodb-lock` (v2.0.0) does
 * not export a `DynamoDBLock` class. It exposes `dynamoDBLockClientFactory`,
 * which returns a {@link LockClient} whose `lock(lockGroup, lockId, options)`
 * acquires a lock and `releaseLock(lock)` releases it. This module wraps that
 * client behind {@link withLock} so the rest of the agent never touches the
 * library directly.
 *
 * Lock semantics mapped onto the library options (Requirements 6.3, 6.4, 6.5):
 * - **TTL / lease (60s)** -> `leaseDurationInMs: 60_000` with
 *   `prolongLeaseEnabled: false`. A holder keeps the lock for at most the lease;
 *   if an invocation crashes the lock auto-releases once the lease elapses, and
 *   the table's `ttl` attribute lets DynamoDB sweep the abandoned row
 *   (Requirement 6.4). We intentionally do NOT prolong the lease: agent
 *   processing is well under a minute, and a fixed lease is the safety net.
 * - **Acquisition timeout (10s)** -> the library waits (potentially a full
 *   lease) to steal a contended lock, so we race acquisition against a 10s
 *   timer. On timeout {@link withLock} throws {@link LockAcquisitionTimeoutError}
 *   so the agent can let the SQS message return to the queue for retry
 *   (Requirement 6.3).
 * - **Owner-only release** -> handled by the library's conditional delete
 *   (only the record-version/owner that holds the lock can release it,
 *   Requirement 6.5).
 *
 * Table schema: the lock client addresses rows by `customerId` (partition key)
 * plus a constant `lockGroup` sort key, and stores the lease deadline under the
 * `ttl` attribute. See {@link getLockClient} for the configured key names.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocument } from "@aws-sdk/lib-dynamodb";
import {
  dynamoDBLockClientFactory,
  type Lock,
  type LockOptions,
} from "@deliveryhero/dynamodb-lock";

/** Lock lease / TTL in milliseconds (Requirement 6.4 — 60 seconds). */
export const LOCK_TTL_MS = 60_000;

/** Max time to wait to acquire a contended lock (Requirement 6.3 — 10 seconds). */
export const LOCK_ACQUISITION_TIMEOUT_MS = 10_000;

/**
 * Sort-key value used for every session lock row. The agent only ever locks on
 * `customerId`, so a single constant group keeps all lock rows in one logical
 * group while satisfying the library's composite-key requirement.
 */
export const LOCK_GROUP = "session";

/**
 * Structural subset of the library's `LockClient` that {@link withLock} relies
 * on. Declaring it explicitly lets tests inject a lightweight fake without
 * standing up DynamoDB; the real `LockClient` satisfies this shape.
 */
export interface SessionLockClient {
  lock(
    lockGroup: string,
    lockId: string,
    lockOptions?: LockOptions,
  ): Promise<Lock>;
  releaseLock(lock: Lock): Promise<void>;
}

let lockClient: SessionLockClient | undefined;

/** Resolve the session locks table name from the environment (set by AgentStack). */
function locksTableName(): string {
  const name = process.env.SESSION_LOCKS_TABLE_NAME;
  if (!name) {
    // Misconfiguration — surfaces as a failed invocation so the message retries.
    throw new Error("SESSION_LOCKS_TABLE_NAME is not set");
  }
  return name;
}

/**
 * Return the shared {@link SessionLockClient}, creating it on first use.
 *
 * The client is configured to match the AgentStack session locks table:
 * `customerId` partition key, `lockGroup` sort key, and `ttl` TTL attribute. The
 * library writes the lease deadline into `ttl` so DynamoDB can sweep rows left
 * behind by crashed holders (Requirement 6.4).
 */
export function getLockClient(): SessionLockClient {
  if (!lockClient) {
    const documentClient = DynamoDBDocument.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
    lockClient = dynamoDBLockClientFactory(documentClient, {
      tableName: locksTableName(),
      partitionKey: "customerId",
      sortKey: "lockGroup",
      ttlKey: "ttl",
      ttlInMs: LOCK_TTL_MS,
    });
  }
  return lockClient;
}

/**
 * Override the lock client. Test seam only — production code never calls this.
 * Pass `undefined` to reset back to the lazily-created client.
 */
export function setLockClientForTesting(
  client: SessionLockClient | undefined,
): void {
  lockClient = client;
}

/**
 * Thrown by {@link withLock} when the lock cannot be acquired within
 * {@link LOCK_ACQUISITION_TIMEOUT_MS}. The agent treats this as a transient
 * failure and lets the SQS message return to the queue for retry
 * (Requirement 6.3).
 */
export class LockAcquisitionTimeoutError extends Error {
  constructor(
    public readonly customerId: string,
    public readonly timeoutMs: number,
  ) {
    super(
      `Timed out acquiring session lock for customer ${customerId} after ${timeoutMs}ms`,
    );
    this.name = "LockAcquisitionTimeoutError";
  }
}

/**
 * Acquire the session lock for `customerId`, racing the library's acquisition
 * against a {@link LOCK_ACQUISITION_TIMEOUT_MS} timer. If the timer wins, reject
 * with {@link LockAcquisitionTimeoutError}; if the (slow) acquisition resolves
 * after we've already given up, release that orphaned lock as best-effort
 * cleanup so it doesn't linger for the full lease.
 */
async function acquireWithTimeout(customerId: string): Promise<Lock> {
  const client = getLockClient();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new LockAcquisitionTimeoutError(
          customerId,
          LOCK_ACQUISITION_TIMEOUT_MS,
        ),
      );
    }, LOCK_ACQUISITION_TIMEOUT_MS);
  });

  const acquisition = client.lock(LOCK_GROUP, customerId, {
    leaseDurationInMs: LOCK_TTL_MS,
    prolongLeaseEnabled: false,
  });

  try {
    return await Promise.race([acquisition, timeout]);
  } catch (error) {
    // If acquisition eventually succeeds after the timeout fired, release the
    // now-orphaned lock instead of holding it until the lease expires.
    void acquisition
      .then((lateLock) => client.releaseLock(lateLock))
      .catch(() => {
        /* best-effort cleanup; nothing else to do */
      });
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Run `fn` while holding the per-customer session lock, releasing it in a
 * `finally` so the lock is always freed even if `fn` throws
 * (Requirements 6.1, 6.2, 6.5).
 *
 * @param customerId  The customer whose session is being mutated; used as the
 *                    lock partition key so only one invocation processes a
 *                    given customer at a time.
 * @param fn          The critical section (restore session -> process -> persist).
 * @returns The value returned by `fn`.
 * @throws LockAcquisitionTimeoutError when the lock cannot be acquired within
 *   {@link LOCK_ACQUISITION_TIMEOUT_MS} (Requirement 6.3).
 */
export async function withLock<T>(
  customerId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const client = getLockClient();
  const lock = await acquireWithTimeout(customerId);
  try {
    return await fn();
  } finally {
    await client.releaseLock(lock);
  }
}
