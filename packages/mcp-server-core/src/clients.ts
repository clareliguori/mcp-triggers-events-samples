/**
 * Side-effecting client singletons and injection seams shared by both MCP
 * servers (MCP Server 1 / USGS and MCP Server 2 / Scheduler).
 *
 * Every dependency that touches the outside world — the DynamoDB document
 * client, the KMS client, `fetch`, and `sleep` — is created lazily as a module
 * singleton and is overridable through a `setXForTesting` seam. The two Lambda
 * handlers used to each carry their own private copy of these seams; centralizing
 * them here keeps a single definition the handlers re-export, so tests inject
 * fakes against the same module the production code reads. Production code never
 * calls the setters.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// ---------------------------------------------------------------------------
// fetch / sleep injection seams (test seams; production uses the defaults)
// ---------------------------------------------------------------------------

/**
 * Minimal `fetch` signature covering both the USGS feed read (delegated to
 * poller.ts, which only reads `.json()`) and the webhook delivery POST (which
 * only reads `.ok`/`.status`). It is assignable to poller's narrower
 * `FetchLike`, so the same injected implementation drives both.
 */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/** Sleep abstraction so backoff waits can be faked (no real delays) in tests. */
export type SleepLike = (ms: number) => Promise<void>;

let fetchImpl: FetchLike = fetch as unknown as FetchLike;
let sleepImpl: SleepLike = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The current `fetch` implementation used for both the USGS poll and webhook
 * delivery. Reads the module singleton so a test override takes effect.
 */
export function getFetchImpl(): FetchLike {
  return fetchImpl;
}

/**
 * The current `sleep` implementation used between delivery retries. Reads the
 * module singleton so a test override takes effect.
 */
export function getSleepImpl(): SleepLike {
  return sleepImpl;
}

/**
 * Override the `fetch` implementation used for both the USGS poll and webhook
 * delivery. Test seam only. Pass `undefined` to reset to the global `fetch`.
 */
export function setFetchForTesting(impl: FetchLike | undefined): void {
  fetchImpl = impl ?? (fetch as unknown as FetchLike);
}

/**
 * Override the `sleep` used between delivery retries. Test seam only — tests
 * inject a fake so they assert the backoff schedule without actually waiting
 * 1s/5s/30s. Pass `undefined` to reset to the real timer-based sleep.
 */
export function setSleepForTesting(impl: SleepLike | undefined): void {
  sleepImpl =
    impl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

// ---------------------------------------------------------------------------
// DynamoDB document client (lazy singleton + test seam)
// ---------------------------------------------------------------------------

let documentClient: DynamoDBDocumentClient | undefined;

/** Return the shared {@link DynamoDBDocumentClient}, creating it on first use. */
export function getDocumentClient(): DynamoDBDocumentClient {
  if (!documentClient) {
    documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return documentClient;
}

/**
 * Override the DynamoDB document client. Test seam only. Pass `undefined` to
 * reset back to the lazily-created client.
 */
export function setDocumentClientForTesting(
  client: DynamoDBDocumentClient | undefined,
): void {
  documentClient = client;
}

// ---------------------------------------------------------------------------
// KMS client (lazy singleton + test seam)
// ---------------------------------------------------------------------------

let kmsClient: KMSClient | undefined;

/** Return the shared {@link KMSClient}, creating it on first use. */
export function getKmsClient(): KMSClient {
  if (!kmsClient) {
    kmsClient = new KMSClient({});
  }
  return kmsClient;
}

/**
 * Override the KMS client. Test seam only. Pass `undefined` to reset back to
 * the lazily-created client.
 */
export function setKmsClientForTesting(client: KMSClient | undefined): void {
  kmsClient = client;
}
