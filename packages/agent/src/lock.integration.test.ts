/**
 * Integration test for distributed session-lock behavior (task 9.2, Property 8:
 * Session Write Serialization / Mutual Exclusion).
 *
 * Unlike the unit tests in `lock.test.ts` — which replace the lock client with a
 * trivial fake to check that {@link withLock} wires acquire/release correctly —
 * this suite exercises the REAL `@deliveryhero/dynamodb-lock` client driving the
 * REAL {@link withLock}. Only the DynamoDB document client is mocked, by an
 * in-memory table that faithfully reproduces the two DynamoDB primitives the
 * lock library relies on:
 *
 *  - **Conditional writes**: `createNewLock` uses
 *    `attribute_not_exists(pk) AND attribute_not_exists(sk)` so only one caller
 *    can create a given lock row; `updateLockWithNewLockContent` and
 *    `deleteLock` are gated on the stored `recordVersionNumber` (and `ownerName`
 *    for delete). This is what makes the lock mutually exclusive
 *    (Requirements 6.1, 6.2) and owner-scoped on release (Requirement 6.5).
 *  - **TTL sweep**: rows whose `ttl` (epoch seconds) has passed are deleted by
 *    DynamoDB and read as absent, so a lock abandoned by a crashed holder can be
 *    re-acquired by a new caller once its 60s lease elapses (Requirement 6.4).
 *
 * Because the library waits a full lease duration to steal a still-valid lock,
 * and {@link withLock} races acquisition against a 10s timeout, a contended lock
 * surfaces as a {@link LockAcquisitionTimeoutError} rather than a second
 * concurrent critical section — exactly the serialization guarantee we want.
 *
 * Validates: Requirements 6.1, 6.2, 6.4, 6.5
 */

import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type {
  DeleteCommandInput,
  DeleteCommandOutput,
  DynamoDBDocument,
  GetCommandInput,
  GetCommandOutput,
  PutCommandInput,
  PutCommandOutput,
  UpdateCommandInput,
  UpdateCommandOutput,
} from "@aws-sdk/lib-dynamodb";
import { dynamoDBLockClientFactory } from "@deliveryhero/dynamodb-lock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LOCK_ACQUISITION_TIMEOUT_MS,
  LOCK_GROUP,
  LOCK_TTL_MS,
  LockAcquisitionTimeoutError,
  type SessionLockClient,
  setLockClientForTesting,
  withLock,
} from "./lock.js";

// Key/attribute names must match the AgentStack session-locks table config in
// `lock.ts` (getLockClient) so the test stays faithful to production.
const PARTITION_KEY = "customerId";
const SORT_KEY = "lockGroup";
const TTL_KEY = "ttl";
const TABLE_NAME = "test-session-locks";

// Fixed wall-clock base so TTL (epoch-seconds) math is deterministic.
const BASE_TIME_MS = 1_700_000_000_000;

/** Build a DynamoDB `ConditionalCheckFailedException`-shaped error. */
function conditionalCheckFailed(): Error {
  // The lock library branches on `error.name === ConditionalCheckFailedException.name`,
  // so the name is the only field that matters here.
  const err = new Error("The conditional request failed");
  err.name = ConditionalCheckFailedException.name;
  return err;
}

interface RecordedOp {
  type: "get" | "put" | "update" | "delete";
  key: string;
  condition?: string;
  values?: Record<string, unknown>;
}

type LockItem = Record<string, unknown>;

/**
 * In-memory stand-in for the `DynamoDBDocument` the lock library talks to.
 *
 * It implements just the four convenience methods the library uses
 * (`get`/`put`/`update`/`delete`) with enough condition-expression evaluation to
 * reproduce DynamoDB's optimistic-concurrency and TTL semantics. Every method
 * performs its read-check-write synchronously before returning its promise, so
 * concurrent callers observe atomic check-and-set — the property real DynamoDB
 * conditional writes give us.
 */
class InMemoryLockTable {
  private readonly items = new Map<string, LockItem>();
  readonly ops: RecordedOp[] = [];

  private static keyOf(key: Record<string, unknown> | undefined): string {
    return `${String(key?.[PARTITION_KEY])}|${String(key?.[SORT_KEY])}`;
  }

  /**
   * Return the live item at `key`, lazily sweeping it if its TTL has passed.
   * Models DynamoDB deleting expired rows and reading them as absent
   * (Requirement 6.4).
   */
  private liveItem(key: string): LockItem | undefined {
    const item = this.items.get(key);
    if (!item) {
      return undefined;
    }
    const ttl = item[TTL_KEY];
    if (typeof ttl === "number" && ttl * 1000 <= Date.now()) {
      this.items.delete(key);
      return undefined;
    }
    return item;
  }

  /** Evaluate the subset of condition expressions the lock library emits. */
  private static conditionMet(
    item: LockItem | undefined,
    condition: string | undefined,
    values: Record<string, unknown>,
  ): boolean {
    // Every gated expression requires the row to exist.
    if (!item) {
      return false;
    }
    if (
      condition?.includes("recordVersionNumber") &&
      item.recordVersionNumber !== values[":recordVersionNumber"]
    ) {
      return false;
    }
    if (
      condition?.includes("ownerName") &&
      item.ownerName !== values[":ownerName"]
    ) {
      return false;
    }
    return true;
  }

  /** Seed a pre-existing lock row (e.g. a crashed holder's leftover). */
  seed(item: LockItem): void {
    this.items.set(InMemoryLockTable.keyOf(item), { ...item });
  }

  /** Read the live row for a customer, honoring TTL sweep. */
  stored(
    customerId: string,
    lockGroup: string = LOCK_GROUP,
  ): LockItem | undefined {
    return this.liveItem(`${customerId}|${lockGroup}`);
  }

  readonly get = (params: GetCommandInput): Promise<GetCommandOutput> => {
    const key = InMemoryLockTable.keyOf(params.Key);
    const item = this.liveItem(key);
    this.ops.push({ type: "get", key });
    return Promise.resolve({
      Item: item ? { ...item } : undefined,
      $metadata: {},
    });
  };

  readonly put = (params: PutCommandInput): Promise<PutCommandOutput> => {
    const item = params.Item ?? {};
    const key = InMemoryLockTable.keyOf(item);
    this.ops.push({ type: "put", key, condition: params.ConditionExpression });
    if (
      params.ConditionExpression?.includes("attribute_not_exists") &&
      this.liveItem(key)
    ) {
      // A live lock already exists -> the create-if-absent condition fails.
      return Promise.reject(conditionalCheckFailed());
    }
    this.items.set(key, { ...item });
    return Promise.resolve({ $metadata: {} });
  };

  readonly update = (
    params: UpdateCommandInput,
  ): Promise<UpdateCommandOutput> => {
    const key = InMemoryLockTable.keyOf(params.Key);
    const values = params.ExpressionAttributeValues ?? {};
    this.ops.push({
      type: "update",
      key,
      condition: params.ConditionExpression,
      values,
    });
    const existing = this.liveItem(key);
    if (
      !InMemoryLockTable.conditionMet(
        existing,
        params.ConditionExpression,
        values,
      )
    ) {
      return Promise.reject(conditionalCheckFailed());
    }
    // Apply the SET clause: the library names update values `:new<attr>`.
    const next: LockItem = { ...(existing ?? {}) };
    for (const [valueKey, value] of Object.entries(values)) {
      if (valueKey.startsWith(":new")) {
        next[valueKey.slice(":new".length)] = value;
      }
    }
    this.items.set(key, next);
    return Promise.resolve({ $metadata: {} });
  };

  readonly delete = (
    params: DeleteCommandInput,
  ): Promise<DeleteCommandOutput> => {
    const key = InMemoryLockTable.keyOf(params.Key);
    const values = params.ExpressionAttributeValues ?? {};
    this.ops.push({
      type: "delete",
      key,
      condition: params.ConditionExpression,
      values,
    });
    const existing = this.liveItem(key);
    if (
      !InMemoryLockTable.conditionMet(
        existing,
        params.ConditionExpression,
        values,
      )
    ) {
      return Promise.reject(conditionalCheckFailed());
    }
    this.items.delete(key);
    return Promise.resolve({ $metadata: {} });
  };
}

/** Construct the real lock client backed by the in-memory table. */
function realLockClientOver(table: InMemoryLockTable): SessionLockClient {
  return dynamoDBLockClientFactory(table as unknown as DynamoDBDocument, {
    tableName: TABLE_NAME,
    partitionKey: PARTITION_KEY,
    sortKey: SORT_KEY,
    ttlKey: TTL_KEY,
    ttlInMs: LOCK_TTL_MS,
  });
}

/** Build a seed lock row for `customerId`, optionally already TTL-expired. */
function seedRow(customerId: string, opts: { expired: boolean }): LockItem {
  const nowMs = Date.now();
  return {
    [PARTITION_KEY]: customerId,
    [SORT_KEY]: LOCK_GROUP,
    recordVersionNumber: "seed-rvn",
    ownerName: "seed-owner",
    lastUpdatedTimeInMs: opts.expired ? nowMs - 2 * LOCK_TTL_MS : nowMs,
    leaseDurationInMs: LOCK_TTL_MS,
    additionalAttributes: {},
    [TTL_KEY]: opts.expired
      ? Math.round(nowMs / 1000) - 10
      : Math.round((nowMs + LOCK_TTL_MS) / 1000),
  };
}

/**
 * A controllable critical section that tracks concurrency so tests can assert
 * mutual exclusion. `enter` resolves once the section is running; the section
 * stays in-flight until `release` is called.
 */
function makeCriticalSection(tracker: {
  current: number;
  max: number;
  order: string[];
}) {
  return (name: string) => {
    let release!: () => void;
    let enter!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const fn = async (): Promise<string> => {
      tracker.current += 1;
      tracker.max = Math.max(tracker.max, tracker.current);
      tracker.order.push(`${name}:start`);
      enter();
      await released;
      tracker.order.push(`${name}:end`);
      tracker.current -= 1;
      return name;
    };
    return { fn, release, entered };
  };
}

/**
 * Flush queued microtasks (the fake table resolves synchronously, so lock
 * acquisition/release settles on the microtask queue) without advancing the
 * wall clock. A few rounds cover the library's multi-step await chains.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

let table: InMemoryLockTable;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(BASE_TIME_MS));
  table = new InMemoryLockTable();
  setLockClientForTesting(realLockClientOver(table));
});

afterEach(() => {
  setLockClientForTesting(undefined);
  vi.useRealTimers();
});

describe("withLock — distributed lock behavior (Property 8)", () => {
  it("serializes two concurrent withLock calls for the same customer (mutual exclusion)", async () => {
    // Validates: Requirements 6.1, 6.2
    const tracker = { current: 0, max: 0, order: [] as string[] };
    const critical = makeCriticalSection(tracker);

    // Caller A acquires first and holds the lock inside its critical section.
    const a = critical("A");
    const pA = withLock("cust-shared", a.fn);
    await flushMicrotasks();
    await a.entered;
    expect(tracker.order).toEqual(["A:start"]);
    // A's lock row exists and is held.
    expect(table.stored("cust-shared")).toBeDefined();

    // Caller B contends for the SAME customer while A still holds the lock.
    const b = critical("B");
    const pB = withLock("cust-shared", b.fn);
    const bRejects = expect(pB).rejects.toBeInstanceOf(
      LockAcquisitionTimeoutError,
    );
    await flushMicrotasks();

    // B cannot acquire while A holds: its critical section has NOT started.
    expect(tracker.order).toEqual(["A:start"]);
    expect(tracker.current).toBe(1);

    // After the 10s acquisition timeout, B gives up (message will retry via SQS).
    await vi.advanceTimersByTimeAsync(LOCK_ACQUISITION_TIMEOUT_MS);
    await bRejects;
    expect(tracker.order).not.toContain("B:start");

    // A finishes and releases; the two sections never ran simultaneously.
    a.release();
    await flushMicrotasks();
    await expect(pA).resolves.toBe("A");
    expect(tracker.max).toBe(1);
    expect(tracker.order).toEqual(["A:start", "A:end"]);
    // Release removed A's lock row.
    expect(table.stored("cust-shared")).toBeUndefined();
  });

  it("does not block concurrent withLock calls for different customers", async () => {
    // Validates: Requirement 6.2 (the lock is scoped per customer)
    const tracker = { current: 0, max: 0, order: [] as string[] };
    const critical = makeCriticalSection(tracker);

    const a = critical("A");
    const b = critical("B");
    const pA = withLock("cust-A", a.fn);
    const pB = withLock("cust-B", b.fn);

    await flushMicrotasks();
    await Promise.all([a.entered, b.entered]);

    // Both critical sections are running at the same time — no false blocking.
    expect(tracker.current).toBe(2);
    expect(tracker.max).toBe(2);

    a.release();
    b.release();
    await flushMicrotasks();
    await expect(Promise.all([pA, pB])).resolves.toEqual(["A", "B"]);
    expect(table.stored("cust-A")).toBeUndefined();
    expect(table.stored("cust-B")).toBeUndefined();
  });

  it("acquires a lock whose TTL has expired (crashed holder auto-released)", async () => {
    // Validates: Requirement 6.4 — a 60s TTL auto-releases locks left behind by
    // crashed invocations so a new caller can acquire immediately.
    table.seed(seedRow("cust-stale", { expired: true }));
    // Sanity check: the expired row is swept and reads as absent.
    expect(table.stored("cust-stale")).toBeUndefined();

    const fn = vi.fn(() => Promise.resolve("processed"));
    // No timer advancement needed: with the stale row swept, acquisition is a
    // fresh create and completes within microtasks (well under the 10s timeout).
    await expect(withLock("cust-stale", fn)).resolves.toBe("processed");
    expect(fn).toHaveBeenCalledTimes(1);
    // The lock was acquired and then released.
    expect(table.stored("cust-stale")).toBeUndefined();
  });

  it("blocks a new caller while an unexpired lock is held, then times out", async () => {
    // Validates: Requirements 6.2, 6.4 — a still-valid lease is honored; the
    // contending caller waits and ultimately times out rather than stealing it.
    table.seed(seedRow("cust-held", { expired: false }));

    const fn = vi.fn(() => Promise.resolve("processed"));
    const pending = withLock("cust-held", fn);
    const rejects = expect(pending).rejects.toBeInstanceOf(
      LockAcquisitionTimeoutError,
    );

    await flushMicrotasks();
    expect(fn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(LOCK_ACQUISITION_TIMEOUT_MS);
    await rejects;
    expect(fn).not.toHaveBeenCalled();
    // The held lock row is untouched (not stolen) by the timed-out caller.
    expect(table.stored("cust-held")).toBeDefined();
  });

  it("releases the lock with an owner-scoped conditional delete", async () => {
    // Validates: Requirement 6.5 — only the lock owner can release the lock, via
    // a conditional delete gated on recordVersionNumber AND ownerName.
    await expect(
      withLock("cust-release", () => Promise.resolve("done")),
    ).resolves.toBe("done");

    const del = table.ops.filter((op) => op.type === "delete").at(-1);
    expect(del).toBeDefined();
    expect(del?.condition).toContain("recordVersionNumber");
    expect(del?.condition).toContain("ownerName");
    expect(del?.values).toHaveProperty(":recordVersionNumber");
    expect(del?.values).toHaveProperty(":ownerName");
    // Lock row removed after a successful, owner-verified release.
    expect(table.stored("cust-release")).toBeUndefined();
  });
});
