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
import { GetObjectCommand, NoSuchKey, S3Client } from "@aws-sdk/client-s3";
import { ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@smithy/signature-v4";
import type { HttpRequest } from "@smithy/types";
import type {
  BriefingReport,
  ConversationMessage,
  CustomerConfig,
  McpEventPayload,
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

/**
 * A small client bound to a resolved {@link StackConfig}. Exposes the Data API
 * and AWS operations the flows need, all as IAM (SigV4) backend calls.
 */
export class Harness {
  private readonly s3: S3Client;
  private readonly sqs: SQSClient;

  constructor(public readonly config: StackConfig) {
    this.s3 = new S3Client({ region: config.region });
    this.sqs = new SQSClient({ region: config.region });
  }

  /** Join the Data API base URL with a path. */
  private dataApi(path: string): string {
    const base = (this.config.dataApiUrl ?? "").replace(/\/+$/, "");
    return `${base}${path}`;
  }

  /** PUT a customer config. */
  putConfig(
    customerId: string,
    input: Pick<
      CustomerConfig,
      | "displayName"
      | "subscriptionParams"
      | "briefingPrompt"
      | "briefingSchedule"
    >,
  ): Promise<HttpResult> {
    return signedRequest(
      {
        method: "PUT",
        url: this.dataApi(
          `/customers/${encodeURIComponent(customerId)}/config`,
        ),
        body: JSON.stringify(input),
      },
      this.config.region,
    );
  }

  /** GET a customer config. */
  getConfig(customerId: string): Promise<HttpResult> {
    return signedRequest(
      {
        method: "GET",
        url: this.dataApi(
          `/customers/${encodeURIComponent(customerId)}/config`,
        ),
      },
      this.config.region,
    );
  }

  /** DELETE (soft) a customer config. */
  deleteConfig(customerId: string): Promise<HttpResult> {
    return signedRequest(
      {
        method: "DELETE",
        url: this.dataApi(
          `/customers/${encodeURIComponent(customerId)}/config`,
        ),
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

  /** Trigger a manual briefing for a customer (forwarded to MCP Server 2). */
  triggerBriefing(customerId: string, reason?: string): Promise<HttpResult> {
    return signedRequest(
      {
        method: "POST",
        url: this.dataApi(
          `/trigger-briefing/${encodeURIComponent(customerId)}`,
        ),
        body: JSON.stringify(reason !== undefined ? { reason } : {}),
      },
      this.config.region,
    );
  }

  /** List a customer's report summaries (optionally only the latest). */
  listReports(customerId: string, latest = false): Promise<HttpResult> {
    const suffix = latest ? "?latest=true" : "";
    return signedRequest(
      {
        method: "GET",
        url: this.dataApi(
          `/customers/${encodeURIComponent(customerId)}/reports${suffix}`,
        ),
      },
      this.config.region,
    );
  }

  /** Read the agent's conversation history for a customer via the Data API. */
  async getSessionMessages(customerId: string): Promise<ConversationMessage[]> {
    const result = await signedRequest(
      {
        method: "GET",
        url: this.dataApi(
          `/customers/${encodeURIComponent(customerId)}/session/messages`,
        ),
      },
      this.config.region,
    );
    if (result.statusCode !== 200) {
      throw new Error(
        `GET session messages for ${customerId} returned ${result.statusCode}: ${result.body}`,
      );
    }
    const body = result.json as
      | { messages?: ConversationMessage[] }
      | undefined;
    return body?.messages ?? [];
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
    const target = `${(this.config.webhookUrl ?? "").replace(/\/+$/, "")}`;
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
