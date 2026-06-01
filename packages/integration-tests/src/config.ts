/**
 * Stack-configuration loading and the skip-when-not-deployed guard for the
 * end-to-end integration suite (task 13.2).
 *
 * These tests exercise a **deployed** MCP Events Serverless Agent stack: they
 * call the live Data API, deliver signed webhooks to the live Webhook Receiver,
 * and read session/report objects the live Serverless Agent writes. That makes
 * them fundamentally different from the unit / property suites (which run fully
 * in-process against mocks): they need real endpoints, real bucket/queue names,
 * and real AWS credentials for the deployed account.
 *
 * Because a stack is not always deployed (and CI typically has no stack), the
 * suite reads every endpoint / resource name it needs from the environment and
 * **skips gracefully** when the required values are absent rather than failing.
 * This is the standard pattern for deployed-stack integration tests: with no
 * stack configured, `npx vitest run packages/integration-tests` still exits 0
 * with every e2e test reported as skipped; with a stack configured, the same
 * command runs the flows for real.
 *
 * ## Where configuration comes from
 *
 * Two interchangeable sources, checked in this order (later sources do not
 * override values already set by an earlier one):
 *
 * 1. **Individual environment variables** (highest precedence) — e.g.
 *    `DATA_API_URL`, `WEBHOOK_URL`, `EVENT_QUEUE_URL`. Convenient for ad-hoc
 *    runs: `DATA_API_URL=... WEBHOOK_URL=... npx vitest run packages/integration-tests`.
 * 2. **A CDK outputs file** referenced by `CDK_OUTPUTS_FILE` — the JSON written
 *    by `cdk deploy --all --outputs-file <file>`. Its shape is
 *    `{ "<StackName>": { "<OutputId>": "<value>" } }`; this loader maps the
 *    relevant `CfnOutput`s (see `packages/cdk/lib/*`) onto the fields below.
 *
 * Whichever source provides a value, the resolved {@link StackConfig} is the
 * single contract the harness and tests consume.
 */

import { readFileSync } from "node:fs";

/**
 * The resolved set of deployed-stack endpoints and resource names the e2e
 * suite can use. Every field is optional: individual flows declare exactly
 * which fields they need (see {@link gate}) and skip when any are missing, so a
 * partially-configured environment can still run the subset of flows it
 * supports.
 */
export interface StackConfig {
  /** Data API base URL (custom domain or invoke URL), e.g. `https://api.earthquake-agent.example.com`. */
  dataApiUrl?: string;
  /** Webhook Receiver delivery endpoint, e.g. `https://webhook.earthquake-agent.example.com`. */
  webhookUrl?: string;
  /** MCP Server 1 (USGS feed) base URL. */
  usgsMcpUrl?: string;
  /** MCP Server 2 (scheduler) base URL. */
  schedulerMcpUrl?: string;
  /** Name of the agent sessions S3 bucket. */
  sessionsBucketName?: string;
  /** Name of the briefing reports S3 bucket. */
  reportsBucketName?: string;
  /** URL of the main SQS event queue the Webhook Receiver enqueues to. */
  eventQueueUrl?: string;
  /** URL of the dead-letter queue the Serverless Agent routes un-routable events to. */
  deadLetterQueueUrl?: string;
  /** AWS region used for SigV4 signing and SDK clients. */
  region: string;
}

/** Keys of {@link StackConfig} that name a required endpoint / resource. */
export type StackConfigKey = Exclude<keyof StackConfig, "region">;

/** Resolve the AWS region from the standard environment variables. */
function resolveRegion(): string {
  return (
    process.env.AWS_REGION ??
    process.env.AWS_DEFAULT_REGION ??
    process.env.CDK_DEFAULT_REGION ??
    "us-east-1"
  );
}

/**
 * Convert an SQS queue ARN (`arn:aws:sqs:<region>:<account>:<name>`) to its
 * HTTPS queue URL (`https://sqs.<region>.amazonaws.com/<account>/<name>`).
 *
 * The CDK stack exports the dead-letter queue as an ARN (not a URL), so the
 * outputs-file path derives the URL from it. Returns `undefined` for anything
 * that is not a well-formed SQS ARN.
 */
export function queueUrlFromArn(arn: string | undefined): string | undefined {
  if (!arn) {
    return undefined;
  }
  const parts = arn.split(":");
  // arn : aws : sqs : region : account : name
  if (parts.length !== 6 || parts[2] !== "sqs") {
    return undefined;
  }
  const [, , , region, account, name] = parts;
  if (!region || !account || !name) {
    return undefined;
  }
  return `https://sqs.${region}.amazonaws.com/${account}/${name}`;
}

/** Read and parse the CDK outputs file, returning `{}` when unset/unreadable. */
function loadOutputsFile(): Record<string, Record<string, string>> {
  const path = process.env.CDK_OUTPUTS_FILE;
  if (!path) {
    return {};
  }
  try {
    const text = readFileSync(path, "utf8");
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, Record<string, string>>;
    }
  } catch (error) {
    // A referenced-but-unreadable outputs file is a configuration error worth
    // surfacing, but it must not crash collection — log and fall back to env.
    console.warn(
      `Could not read CDK_OUTPUTS_FILE at ${path}; falling back to environment variables`,
      error instanceof Error ? error.message : String(error),
    );
  }
  return {};
}

/**
 * Read a single output value from a parsed CDK outputs file, tolerating either
 * a `CustomDomainUrl` (preferred) or a plain invoke-`Url` output id.
 */
function fromOutputs(
  outputs: Record<string, Record<string, string>>,
  stack: string,
  ...outputIds: string[]
): string | undefined {
  const stackOutputs = outputs[stack];
  if (!stackOutputs) {
    return undefined;
  }
  for (const id of outputIds) {
    const value = stackOutputs[id];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Load the deployed-stack configuration from the environment and/or a CDK
 * outputs file. Individual environment variables take precedence over the
 * outputs file; anything absent from both is left `undefined`.
 */
export function loadStackConfig(): StackConfig {
  const outputs = loadOutputsFile();

  const dataApiUrl =
    process.env.DATA_API_URL ??
    fromOutputs(
      outputs,
      "DataApiStack",
      "DataApiCustomDomainUrl",
      "DataApiUrl",
    );

  const webhookUrl =
    process.env.WEBHOOK_URL ??
    fromOutputs(outputs, "WebhookReceiverStack", "WebhookCustomDomainUrl");

  const usgsMcpUrl =
    process.env.USGS_MCP_URL ??
    fromOutputs(
      outputs,
      "UsgsServerStack",
      "UsgsMcpCustomDomainUrl",
      "UsgsMcpApiUrl",
    );

  const schedulerMcpUrl =
    process.env.SCHEDULER_MCP_URL ??
    fromOutputs(
      outputs,
      "SchedulerServerStack",
      "SchedulerMcpCustomDomainUrl",
      "SchedulerMcpApiUrl",
    );

  const sessionsBucketName =
    process.env.SESSIONS_BUCKET_NAME ??
    fromOutputs(outputs, "AgentStack", "SessionsBucketName");

  const reportsBucketName =
    process.env.REPORTS_BUCKET_NAME ??
    fromOutputs(outputs, "DataApiStack", "ReportsBucketName");

  const eventQueueUrl =
    process.env.EVENT_QUEUE_URL ??
    fromOutputs(outputs, "WebhookReceiverStack", "WebhookQueueUrl");

  const deadLetterQueueUrl =
    process.env.DEAD_LETTER_QUEUE_URL ??
    queueUrlFromArn(
      fromOutputs(outputs, "WebhookReceiverStack", "WebhookDeadLetterQueueArn"),
    );

  return {
    dataApiUrl,
    webhookUrl,
    usgsMcpUrl,
    schedulerMcpUrl,
    sessionsBucketName,
    reportsBucketName,
    eventQueueUrl,
    deadLetterQueueUrl,
    region: resolveRegion(),
  };
}

/** The outcome of evaluating a flow's configuration requirements. */
export interface Gate {
  /** Whether the required configuration is present (the flow should run). */
  shouldRun: boolean;
  /** The required keys that were missing (empty when `shouldRun` is true). */
  missing: StackConfigKey[];
  /** The resolved configuration (fields may be undefined when skipping). */
  config: StackConfig;
}

/**
 * Evaluate whether a flow can run given the keys it requires.
 *
 * Returns `shouldRun: false` (and the list of missing keys) when any required
 * endpoint / resource is absent, so the caller can switch to `describe.skip`.
 * The resolved {@link StackConfig} is always returned; required values are
 * guaranteed present only when `shouldRun` is true, so tests should read them
 * inside `it`/`beforeAll` (which never run for a skipped suite).
 */
export function gate(required: StackConfigKey[]): Gate {
  const config = loadStackConfig();
  const missing = required.filter((key) => {
    const value = config[key];
    return typeof value !== "string" || value.length === 0;
  });
  return { shouldRun: missing.length === 0, missing, config };
}

/**
 * Read a required string field from the config, throwing a clear error when it
 * is absent. Safe to call inside `it`/`beforeAll` of a suite that has already
 * passed its {@link gate}; the throw only fires on genuine misconfiguration.
 */
export function requireField(config: StackConfig, key: StackConfigKey): string {
  const value = config[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Required stack configuration "${key}" is not set. ` +
        `Provide it via an environment variable or a CDK_OUTPUTS_FILE.`,
    );
  }
  return value;
}
