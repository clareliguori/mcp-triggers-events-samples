/**
 * Test harness for the end-to-end integration suite (task 13.2).
 *
 * This module is the thin client layer the flow tests drive a **deployed**
 * stack through. It bundles three concerns:
 *
 * 1. **IAM SigV4 HTTP** ({@link signedRequest}) — the Data API and the MCP
 *    servers use IAM authorization on their `execute-api` routes, so the suite
 *    signs every request with the deployer's AWS credentials (default provider
 *    chain), exactly like the Serverless Agent / Subscription Manager do in
 *    production. Running as an IAM caller also lets the suite act on behalf of
 *    any customer (Requirement 9.3), which is what these cross-customer flows
 *    need.
 * 2. **Data API helpers** — typed wrappers for the config, subscription,
 *    report, and session routes the flows assert against.
 * 3. **Webhook + AWS helpers** — sign and deliver a Standard Webhooks payload
 *    to the live Webhook Receiver (mirroring what the MCP servers send),
 *    read session/report objects from S3, and poll the DLQ.
 *
 * Everything here is intentionally dependency-light (the AWS SDK clients, the
 * shared signing helpers, and `fetch`) so the flows read as plain end-to-end
 * scenarios.
 */

import { Sha256 } from "@aws-crypto/sha256-js";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  S3Client,
} from "@aws-sdk/client-s3";
import { ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { SignatureV4 } from "@smithy/signature-v4";
import type { HttpRequest } from "@smithy/types";
import type {
  BriefingReport,
  ConversationMessage,
  CustomerConfig,
  McpEventPayload,
  ReportSummary,
} from "@mcp-events/shared";
import { MCP_SUBSCRIPTION_ID_HEADER, signWebhook } from "@mcp-events/shared";

import type { StackConfig } from "./config.js";

/** A raw HTTP response with the parsed body kept as text and (best-effort) JSON. */
export interface HttpResult {
  /** HTTP status code. */
  statusCode: number;
  /** Raw response body text. */
  body: string;
  /** Parsed JSON body when the body was valid JSON, else `undefined`. */
  json?: unknown;
}

/** Options for an outbound signed request. */
export interface SignedRequestOptions {
  method: string;
  /** Absolute URL including path and (optional) query string. */
  url: string;
  /** Optional already-serialized request body (JSON text). */
  body?: string;
  /** Extra headers to include in signing and delivery. */
  headers?: Record<string, string>;
}

/**
 * SigV4-sign a request for the `execute-api` service and deliver it with the
 * global `fetch`. Credentials come from the default provider chain (the same
 * approach the agent uses), so the deployer's environment / role must be able
 * to invoke the API.
 */
export async function signedRequest(
  options: SignedRequestOptions,
  region: string,
): Promise<HttpResult> {
  const url = new URL(options.url);

  const headers: Record<string, string> = {
    host: url.host,
    ...options.headers,
  };
  if (options.body !== undefined && headers["content-type"] === undefined) {
    headers["content-type"] = "application/json";
  }

  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  const signer = new SignatureV4({
    service: "execute-api",
    region,
    credentials: defaultProvider(),
    sha256: Sha256,
  });

  const toSign: HttpRequest = {
    method: options.method,
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname,
    headers,
    body: options.body,
    ...(Object.keys(query).length > 0 && { query }),
  };

  const signed = await signer.sign(toSign);

  const response = await fetch(options.url, {
    method: options.method,
    headers: signed.headers,
    ...(options.body !== undefined && { body: options.body }),
  });

  const text = await response.text();
  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { statusCode: response.status, body: text, json };
}

/** First N characters of a report summary kept in a {@link ReportSummary}. */
const SUMMARY_PREVIEW_LENGTH = 200;

/** Whether an S3 error represents a missing object/bucket or a 404 response. */
function isS3NotFound(error: unknown): boolean {
  if (error instanceof NoSuchKey) {
    return true;
  }
  if (error instanceof Error && error.name === "NoSuchKey") {
    return true;
  }
  const status = (error as { $metadata?: { httpStatusCode?: number } })
    ?.$metadata?.httpStatusCode;
  return status === 404;
}

/**
 * Project a full {@link BriefingReport} to the lightweight {@link ReportSummary}
 * shape the Data API list route returns, so the harness's S3-direct listing
 * matches what `GET /customers/{id}/reports` would have produced.
 */
function toReportSummary(report: BriefingReport): ReportSummary {
  return {
    reportId: report.reportId,
    generatedAt: report.generatedAt,
    periodStart: report.periodStart,
    periodEnd: report.periodEnd,
    totalEarthquakes: report.totalEarthquakes,
    summary: report.summary.slice(0, SUMMARY_PREVIEW_LENGTH),
  };
}

/**
 * Extract the conversation history from a parsed session snapshot, mirroring
 * the Data API's session route. The snapshot is either the application-level
 * `AgentSessionState` shape (top-level `messages`) or the Strands SDK
 * `Snapshot` shape (messages nested under `data`); anything else yields an
 * empty array.
 */
function extractSessionMessages(snapshot: unknown): ConversationMessage[] {
  if (snapshot === null || typeof snapshot !== "object") {
    return [];
  }
  const root = snapshot as Record<string, unknown>;
  if (Array.isArray(root.messages)) {
    return root.messages as ConversationMessage[];
  }
  const data = root.data;
  if (data !== null && typeof data === "object") {
    const nested = (data as Record<string, unknown>).messages;
    if (Array.isArray(nested)) {
      return nested as ConversationMessage[];
    }
  }
  return [];
}

/**
 * A small client bound to a resolved {@link StackConfig}. Exposes the Data API
 * and AWS operations the flows need.
 *
 * ## IAM vs Cognito on the deployed Data API
 *
 * The harness authenticates with SigV4 (IAM) for every Data API call — it acts
 * as a backend caller so it can operate on any customer (Requirement 9.3). But
 * the deployed Data API splits its surface between two authorizers:
 *
 * - **IAM (AWS_IAM)** routes the harness can call directly: the backend config
 *   read `GET /backend/customers/{id}/config`, the subscription routes
 *   (`GET/POST /customers/{id}/subscriptions`, `GET/PUT /subscriptions/{id}`),
 *   and `POST /customers/{id}/reports`.
 * - **Cognito (COGNITO_USER_POOLS)** routes reserved for the webapp's end-user
 *   JWT, which an IAM-signed request cannot satisfy (it 401s): config
 *   create/update/delete (`PUT`/`DELETE /customers/{id}/config`), the config
 *   read on the webapp path (`GET /customers/{id}/config`), session messages
 *   (`GET /customers/{id}/session/messages`), the reports list / read
 *   (`GET /customers/{id}/reports[/{id}]`), and the manual briefing trigger.
 *
 * So this harness routes each operation to whatever the deployed API actually
 * exposes to an IAM caller, and goes around the API for the rest:
 *
 * - **Config read** -> the IAM backend route `GET /backend/customers/{id}/config`
 *   (the same route the Serverless Agent uses), NOT the Cognito webapp route.
 * - **Config write / delete** -> there is **no** IAM-authorized config
 *   create/update/delete route on the deployed API, so the harness writes the
 *   `CustomerConfig` item **directly to the CustomerConfig DynamoDB table**.
 *   This is not a shortcut: a direct `PutItem` fires the table's DynamoDB
 *   Stream, which is exactly the trigger the Subscription Manager consumes to
 *   create subscriptions — so seeding config this way both drives the test and
 *   exercises the real DynamoDB Stream -> Subscription Manager registration
 *   path the registration flow asserts on.
 * - **Session messages** -> read the agent's session snapshot directly from the
 *   sessions S3 bucket (the `GET .../session/messages` route is Cognito-only).
 * - **Reports list** -> list/read report objects directly from the reports S3
 *   bucket (the `GET .../reports` route is Cognito-only); writes already go
 *   through the IAM `POST .../reports` route the agent uses.
 */
export class Harness {
  private readonly s3: S3Client;
  private readonly sqs: SQSClient;
  private readonly dynamo: DynamoDBDocumentClient;

  constructor(public readonly config: StackConfig) {
    this.s3 = new S3Client({ region: config.region });
    this.sqs = new SQSClient({ region: config.region });
    this.dynamo = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: config.region }),
      { marshallOptions: { removeUndefinedValues: true } },
    );
  }

  /** Join the Data API base URL with a path. */
  private dataApi(path: string): string {
    const base = (this.config.dataApiUrl ?? "").replace(/\/+$/, "");
    return `${base}${path}`;
  }

  /** Resolve the CustomerConfig table name, throwing a clear error when unset. */
  private customerConfigTable(): string {
    const name = this.config.customerConfigTableName;
    if (!name) {
      throw new Error("customerConfigTableName is not configured");
    }
    return name;
  }

  /**
   * Create or update a customer config.
   *
   * The deployed Data API exposes config writes only on the Cognito-authorized
   * `PUT /customers/{id}/config` route, which a SigV4 (IAM) caller cannot use.
   * There is no IAM-authorized config write route, so the harness writes the
   * `CustomerConfig` item **directly to the CustomerConfig DynamoDB table**.
   *
   * This is intentional and load-bearing for the registration flow: a direct
   * `PutItem` fires the table's DynamoDB Stream, which is exactly what the
   * Subscription Manager consumes (stream INSERT -> `events/subscribe` on both
   * MCP servers). Seeding config this way therefore both drives every flow that
   * needs a customer AND exercises the real registration path under test. The
   * item shape mirrors what `PUT /customers/{id}/config` persists (sets
   * `active: true` and stamps `createdAt`/`updatedAt`) so the Subscription
   * Manager's `customerConfigSchema` validation of the stream image passes.
   */
  async putConfig(
    customerId: string,
    input: Pick<
      CustomerConfig,
      | "displayName"
      | "subscriptionParams"
      | "briefingPrompt"
      | "briefingSchedule"
    >,
  ): Promise<CustomerConfig> {
    const now = new Date().toISOString();
    const item: CustomerConfig = {
      customerId,
      displayName: input.displayName,
      subscriptionParams: input.subscriptionParams,
      briefingPrompt: input.briefingPrompt,
      briefingSchedule: input.briefingSchedule,
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    await this.dynamo.send(
      new PutCommand({ TableName: this.customerConfigTable(), Item: item }),
    );
    return item;
  }

  /**
   * Read a customer config via the IAM-authorized backend route
   * `GET /backend/customers/{id}/config` (the same route the Serverless Agent
   * uses). The webapp-facing `GET /customers/{id}/config` route is Cognito-only
   * and would reject this SigV4-signed request with 401.
   */
  getConfig(customerId: string): Promise<HttpResult> {
    return signedRequest(
      {
        method: "GET",
        url: this.dataApi(
          `/backend/customers/${encodeURIComponent(customerId)}/config`,
        ),
      },
      this.config.region,
    );
  }

  /**
   * Delete a customer config by removing its item from the CustomerConfig
   * DynamoDB table (test cleanup). As with {@link putConfig}, the deployed
   * `DELETE /customers/{id}/config` route is Cognito-only with no IAM
   * equivalent, so the harness operates on the table directly. A hard delete
   * (rather than the API's soft `active: false`) keeps repeated test runs from
   * accumulating rows and fires a stream REMOVE the Subscription Manager
   * tolerates.
   */
  async deleteConfig(customerId: string): Promise<void> {
    await this.dynamo.send(
      new DeleteCommand({
        TableName: this.customerConfigTable(),
        Key: { customerId },
      }),
    );
  }

  /**
   * List all customers via the backend route `GET /backend/customers`.
   * This is the route the Subscription Manager's refresh path depends on.
   */
  listCustomers(): Promise<HttpResult> {
    return signedRequest(
      {
        method: "GET",
        url: this.dataApi("/backend/customers"),
      },
      this.config.region,
    );
  }

  /** List a customer's subscriptions. */
  listSubscriptions(customerId: string): Promise<HttpResult> {
    return signedRequest(
      {
        method: "GET",
        url: this.dataApi(
          `/customers/${encodeURIComponent(customerId)}/subscriptions`,
        ),
      },
      this.config.region,
    );
  }

  /**
   * Emit a synthetic earthquake event via the USGS server's POST /emit-test-event
   * endpoint. Delivers to all matching subscriptions via the full SDK webhook
   * delivery path (store lookup, HMAC signing, POST to webhook receiver).
   */
  emitTestEvent(earthquake: Record<string, unknown>): Promise<HttpResult> {
    const base = (this.config.usgsMcpUrl ?? "").replace(/\/+$/, "");
    return signedRequest(
      {
        method: "POST",
        url: `${base}/emit-test-event`,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ earthquake }),
      },
      this.config.region,
    );
  }

  /** Create a subscription record (used to seed routing in the webhook flows). */
  createSubscription(
    customerId: string,
    record: Record<string, unknown>,
  ): Promise<HttpResult> {
    return signedRequest(
      {
        method: "POST",
        url: this.dataApi(
          `/customers/${encodeURIComponent(customerId)}/subscriptions`,
        ),
        body: JSON.stringify(record),
      },
      this.config.region,
    );
  }

  /** GET a single subscription by id. */
  getSubscription(subscriptionId: string): Promise<HttpResult> {
    return signedRequest(
      {
        method: "GET",
        url: this.dataApi(
          `/subscriptions/${encodeURIComponent(subscriptionId)}`,
        ),
      },
      this.config.region,
    );
  }

  /** PUT (update) a subscription by id, e.g. to refresh its expiry. */
  putSubscription(
    subscriptionId: string,
    updates: Record<string, unknown>,
  ): Promise<HttpResult> {
    return signedRequest(
      {
        method: "PUT",
        url: this.dataApi(
          `/subscriptions/${encodeURIComponent(subscriptionId)}`,
        ),
        body: JSON.stringify(updates),
      },
      this.config.region,
    );
  }

  /** List a customer's report summaries (optionally only the latest).
   *
   * The deployed `GET /customers/{id}/reports` route is Cognito-only, so the
   * harness lists and reads the report objects directly from the reports S3
   * bucket — the same `reports/{customerId}/{reportId}.json` layout the Data
   * API reads — projecting each to the {@link ReportSummary} shape and sorting
   * newest-first by `generatedAt`. Report writes still flow through the agent's
   * IAM `POST /customers/{id}/reports` route under test; this only reads back
   * what was written. Returns at most one summary when `latest` is true.
   */
  async listReports(
    customerId: string,
    latest = false,
  ): Promise<ReportSummary[]> {
    const reports = await this.listReportsFromS3(customerId);
    return latest ? reports.slice(0, 1) : reports;
  }

  /** Read the agent's conversation history for a customer.
   *
   * The deployed `GET /customers/{id}/session/messages` route is Cognito-only,
   * so the harness reads the agent's session snapshot directly from the
   * sessions S3 bucket at the same key the Data API reads
   * (`sessions/{customerId}/scopes/agent/agent/snapshots/snapshot_latest.json`)
   * and extracts the conversation history. Returns an empty array when no
   * snapshot exists yet (the customer has not been processed).
   */
  async getSessionMessages(customerId: string): Promise<ConversationMessage[]> {
    const bucket = this.config.sessionsBucketName;
    if (!bucket) {
      throw new Error("sessionsBucketName is not configured");
    }
    const key = `sessions/${customerId}/scopes/agent/agent/snapshots/snapshot_latest.json`;
    let text: string | undefined;
    try {
      const result = await this.s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      text = await result.Body?.transformToString();
    } catch (error) {
      if (isS3NotFound(error)) {
        return [];
      }
      throw error;
    }
    if (!text) {
      return [];
    }
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(text);
    } catch {
      return [];
    }
    return extractSessionMessages(snapshot);
  }

  /**
   * List + read every report object under a customer's reports prefix in S3,
   * projecting each to a {@link ReportSummary} and sorting newest-first.
   */
  private async listReportsFromS3(
    customerId: string,
  ): Promise<ReportSummary[]> {
    const bucket = this.config.reportsBucketName;
    if (!bucket) {
      throw new Error("reportsBucketName is not configured");
    }
    const prefix = `reports/${customerId}/`;
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const listing = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of listing.Contents ?? []) {
        if (obj.Key?.endsWith(".json")) {
          keys.push(obj.Key);
        }
      }
      continuationToken = listing.IsTruncated
        ? listing.NextContinuationToken
        : undefined;
    } while (continuationToken);

    const reports = await Promise.all(
      keys.map(async (key) => {
        const match = /\/([^/]+)\.json$/.exec(key);
        const reportId = match?.[1];
        if (!reportId) {
          return undefined;
        }
        const report = await this.readReportFromS3(customerId, reportId);
        return report ? toReportSummary(report) : undefined;
      }),
    );

    return reports
      .filter((r): r is ReportSummary => r !== undefined)
      .sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt));
  }

  /**
   * Deliver a signed webhook payload to the live Webhook Receiver, mirroring
   * what an MCP server sends: the raw JSON body, the three Standard Webhooks
   * signature headers, and the `X-MCP-Subscription-Id` routing header.
   */
  deliverWebhook(
    subscriptionId: string,
    secret: string,
    event: McpEventPayload,
  ): Promise<HttpResult> {
    return this.deliverRawWebhook(
      subscriptionId,
      secret,
      JSON.stringify(event),
    );
  }

  /**
   * Deliver an arbitrary raw body to the live Webhook Receiver, signed with the
   * subscription's secret. Used by the DLQ flow to send a signature-valid but
   * structurally-invalid event body that passes the receiver's signature check
   * yet fails the agent's MCP payload schema (so the agent dead-letters it).
   */
  async deliverRawWebhook(
    subscriptionId: string,
    secret: string,
    rawBody: string,
  ): Promise<HttpResult> {
    const sig = signWebhook(rawBody, secret);
    // The Webhook Receiver serves deliveries at `POST /webhook` (matching what
    // the Subscription Manager registers as each subscription's callback URL).
    // Posting to the bare receiver origin hits the API Gateway root resource,
    // which has no POST method and returns 403, so target `/webhook` explicitly.
    const target = `${(this.config.webhookUrl ?? "").replace(/\/+$/, "")}/webhook`;
    const response = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [MCP_SUBSCRIPTION_ID_HEADER]: subscriptionId,
        "webhook-id": sig["webhook-id"],
        "webhook-timestamp": sig["webhook-timestamp"],
        "webhook-signature": sig["webhook-signature"],
      },
      body: rawBody,
    });
    const text = await response.text();
    return { statusCode: response.status, body: text };
  }

  /**
   * Read and parse a customer's briefing report directly from the reports S3
   * bucket at `reports/{customerId}/{reportId}.json`. Returns `undefined` when
   * the object does not exist yet.
   */
  async readReportFromS3(
    customerId: string,
    reportId: string,
  ): Promise<BriefingReport | undefined> {
    const bucket = this.config.reportsBucketName;
    if (!bucket) {
      throw new Error("reportsBucketName is not configured");
    }
    try {
      const result = await this.s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: `reports/${customerId}/${reportId}.json`,
        }),
      );
      const text = (await result.Body?.transformToString()) ?? "";
      return JSON.parse(text) as BriefingReport;
    } catch (error) {
      if (error instanceof NoSuchKey) {
        return undefined;
      }
      const status = (error as { $metadata?: { httpStatusCode?: number } })
        ?.$metadata?.httpStatusCode;
      if (status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Receive (and immediately let return) messages currently visible on the
   * dead-letter queue, returning the parsed `dlqReason` attribute and body of
   * each. Used to assert DLQ behavior on simulated failures.
   */
  async receiveDeadLetterMessages(): Promise<
    { body: string; dlqReason?: string; subscriptionId?: string }[]
  > {
    const queueUrl = this.config.deadLetterQueueUrl;
    if (!queueUrl) {
      throw new Error("deadLetterQueueUrl is not configured");
    }
    const result = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 5,
        VisibilityTimeout: 1,
        MessageAttributeNames: ["All"],
      }),
    );
    return (result.Messages ?? []).map((message) => ({
      body: message.Body ?? "",
      dlqReason: message.MessageAttributes?.dlqReason?.StringValue ?? undefined,
      subscriptionId:
        message.MessageAttributes?.subscriptionId?.StringValue ?? undefined,
    }));
  }
}

/** Sleep helper for polling loops. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `fn` until it returns a truthy value or the timeout elapses. Returns the
 * resolved value, or `undefined` if the deadline passes first. Used to wait for
 * the asynchronous, eventually-consistent effects of an event flow (session
 * updated, report written, message arrives on the DLQ).
 */
export async function pollUntil<T>(
  fn: () => Promise<T | undefined>,
  options: { timeoutMs: number; intervalMs: number },
): Promise<T | undefined> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) {
      return value;
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await sleep(options.intervalMs);
  }
}
