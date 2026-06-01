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
 * Three interchangeable sources, checked in this order (later sources only fill
 * fields an earlier one left unset — they never override a value already
 * provided):
 *
 * 1. **Individual environment variables** (highest precedence) — e.g.
 *    `DATA_API_URL`, `WEBHOOK_URL`, `EVENT_QUEUE_URL`. Convenient for ad-hoc
 *    runs: `DATA_API_URL=... WEBHOOK_URL=... npx vitest run packages/integration-tests`.
 * 2. **A CDK outputs file** referenced by `CDK_OUTPUTS_FILE` — the JSON written
 *    by `cdk deploy --all --outputs-file <file>`. Its shape is
 *    `{ "<StackName>": { "<OutputId>": "<value>" } }`; this loader maps the
 *    relevant `CfnOutput`s (see `packages/cdk/lib/*`) onto the fields below.
 * 3. **The live, deployed CloudFormation stack exports** (lowest precedence) —
 *    queried with the AWS SDK via {@link resolveStackConfig}. Every relevant
 *    `CfnOutput` is published with a stable, globally-unique `exportName`
 *    prefixed `EarthquakeAgent-`, so a single (paginated) `ListExports` call
 *    maps those exports onto any field the higher-precedence sources left
 *    unset. This is what lets the suite run against an already-deployed stack
 *    with **no** env vars and **no** outputs file — just AWS credentials.
 *
 * The first two sources are synchronous and resolved by {@link loadStackConfig}
 * (which the always-on `config.test.ts` unit tests exercise). The third is
 * async and only performed on demand by {@link resolveStackConfig} /
 * {@link gateAsync}, so the synchronous behavior — and those unit tests — stay
 * intact.
 *
 * Whichever source provides a value, the resolved {@link StackConfig} is the
 * single contract the harness and tests consume.
 */

import { readFileSync } from "node:fs";

import {
  CloudFormationClient,
  paginateListExports,
} from "@aws-sdk/client-cloudformation";
import { NodeHttpHandler } from "@smithy/node-http-handler";

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
  /**
   * Name of the CustomerConfig DynamoDB table. The harness seeds (and tears
   * down) customer config by writing this table directly, because the Data
   * API's config create/update/delete routes are Cognito-only and have no
   * IAM-authorized path the SigV4 harness can use (see {@link Harness}). A
   * direct PutItem also fires the table's DynamoDB Stream, which is exactly the
   * Subscription Manager registration path the registration flow asserts on.
   */
  customerConfigTableName?: string;
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

  const customerConfigTableName =
    process.env.CUSTOMER_CONFIG_TABLE_NAME ??
    fromOutputs(outputs, "DataApiStack", "CustomerConfigTableName");

  return {
    dataApiUrl,
    webhookUrl,
    usgsMcpUrl,
    schedulerMcpUrl,
    sessionsBucketName,
    reportsBucketName,
    eventQueueUrl,
    deadLetterQueueUrl,
    customerConfigTableName,
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
 * Compute which of the `required` keys are absent (unset or empty) in a
 * resolved {@link StackConfig}. Shared by the sync {@link gate} and the async
 * {@link gateAsync}.
 */
function missingKeys(
  config: StackConfig,
  required: StackConfigKey[],
): StackConfigKey[] {
  return required.filter((key) => {
    const value = config[key];
    return typeof value !== "string" || value.length === 0;
  });
}

/**
 * Evaluate whether a flow can run given the keys it requires.
 *
 * Returns `shouldRun: false` (and the list of missing keys) when any required
 * endpoint / resource is absent, so the caller can switch to `describe.skip`.
 * The resolved {@link StackConfig} is always returned; required values are
 * guaranteed present only when `shouldRun` is true, so tests should read them
 * inside `it`/`beforeAll` (which never run for a skipped suite).
 *
 * This is the **synchronous** gate: it consults only env vars and the CDK
 * outputs file (see {@link loadStackConfig}). For the live-CloudFormation path
 * use {@link gateAsync}.
 */
export function gate(required: StackConfigKey[]): Gate {
  const config = loadStackConfig();
  const missing = missingKeys(config, required);
  return { shouldRun: missing.length === 0, missing, config };
}

/**
 * Evaluate a flow's required keys against an **already-resolved**
 * {@link StackConfig}. Pure and synchronous: pass the config from a single
 * {@link resolveStackConfig} (e.g. resolved once via top-level await) so each
 * flow can decide `describe` vs `describe.skip` without re-querying.
 */
export function gateFromConfig(
  config: StackConfig,
  required: StackConfigKey[],
): Gate {
  const missing = missingKeys(config, required);
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
        `Provide it via an environment variable, a CDK_OUTPUTS_FILE, or a ` +
        `deployed CloudFormation stack (EarthquakeAgent-* exports) reachable ` +
        `with the current AWS credentials.`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Live CloudFormation export resolution (third, lowest-precedence source)
// ---------------------------------------------------------------------------

/**
 * Opt-out toggle for the live CloudFormation lookup. Set
 * `INTEGRATION_DISABLE_CFN_LOOKUP=1` (or `true`) to force the suite to rely on
 * env vars / the outputs file only — useful in environments that have AWS
 * credentials but where reaching CloudFormation is undesirable. When unset, the
 * live lookup runs automatically and fills any field the higher-precedence
 * sources left unset.
 */
function liveLookupDisabled(): boolean {
  const value = process.env.INTEGRATION_DISABLE_CFN_LOOKUP;
  return value === "1" || value === "true";
}

/**
 * Bounded wall-clock budget for the entire CloudFormation `ListExports`
 * resolution (all pages). Kept short so the suite never hangs collection when
 * no stack / no credentials are reachable; on timeout the live source simply
 * contributes nothing and the affected flows skip. Override with
 * `INTEGRATION_CFN_TIMEOUT_MS`.
 */
function liveLookupTimeoutMs(): number {
  const raw = process.env.INTEGRATION_CFN_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8_000;
}

/**
 * Mapping from a {@link StackConfig} field to the CloudFormation export
 * name(s) that can supply it (in preference order) and an optional transform
 * applied to the raw export value. Every export name is the stable
 * `EarthquakeAgent-`-prefixed name published by the CDK stacks
 * (`packages/cdk/lib/*`).
 */
interface ExportMapping {
  key: StackConfigKey;
  /** Candidate export names, highest preference first. */
  exportNames: string[];
  /** Optional transform from the raw export value to the stored field value. */
  transform?: (raw: string) => string | undefined;
}

/**
 * The export-name -> {@link StackConfig} field mapping. The MCP server export
 * names derive from each server's `exportPrefix` (see
 * `packages/cdk/lib/mcp-server-construct.ts` and the values wired in
 * `packages/cdk/lib/{usgs,scheduler}-server-stack.ts`): `UsgsMcp` and
 * `SchedulerMcp`, forming `EarthquakeAgent-<prefix>CustomDomainUrl` (with the
 * plain `...ApiUrl` invoke URL as a fallback).
 */
const EXPORT_MAPPINGS: ExportMapping[] = [
  {
    key: "dataApiUrl",
    exportNames: [
      "EarthquakeAgent-DataApiCustomDomainUrl",
      "EarthquakeAgent-DataApiUrl",
    ],
  },
  {
    key: "webhookUrl",
    exportNames: ["EarthquakeAgent-WebhookCustomDomainUrl"],
  },
  {
    key: "usgsMcpUrl",
    exportNames: [
      "EarthquakeAgent-UsgsMcpCustomDomainUrl",
      "EarthquakeAgent-UsgsMcpApiUrl",
    ],
  },
  {
    key: "schedulerMcpUrl",
    exportNames: [
      "EarthquakeAgent-SchedulerMcpCustomDomainUrl",
      "EarthquakeAgent-SchedulerMcpApiUrl",
    ],
  },
  {
    key: "sessionsBucketName",
    exportNames: ["EarthquakeAgent-SessionsBucketName"],
  },
  {
    key: "reportsBucketName",
    exportNames: ["EarthquakeAgent-ReportsBucketName"],
  },
  {
    key: "eventQueueUrl",
    exportNames: ["EarthquakeAgent-WebhookQueueUrl"],
  },
  {
    key: "deadLetterQueueUrl",
    exportNames: ["EarthquakeAgent-WebhookDeadLetterQueueArn"],
    // The DLQ is exported as an ARN; derive the HTTPS queue URL from it.
    transform: queueUrlFromArn,
  },
  {
    key: "customerConfigTableName",
    exportNames: ["EarthquakeAgent-CustomerConfigTableName"],
  },
];

/**
 * Fetch all CloudFormation exports in the configured region as a
 * `name -> value` map, bounded by {@link liveLookupTimeoutMs}. Returns an empty
 * map on **any** failure (no credentials, no stack, access denied, network
 * error, timeout): the live source simply contributes nothing so flows skip
 * gracefully rather than the suite failing or hanging.
 */
async function loadExports(region: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const timeoutMs = liveLookupTimeoutMs();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Bound the socket-level work too, so a stalled connection cannot outlive the
  // overall budget even if the abort signal is missed.
  const client = new CloudFormationClient({
    region,
    maxAttempts: 1,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: timeoutMs,
      requestTimeout: timeoutMs,
    }),
  });

  try {
    const paginator = paginateListExports({ client, pageSize: 100 }, {});
    for await (const page of paginator) {
      if (controller.signal.aborted) {
        break;
      }
      for (const exp of page.Exports ?? []) {
        if (
          typeof exp.Name === "string" &&
          typeof exp.Value === "string" &&
          exp.Value.length > 0
        ) {
          result.set(exp.Name, exp.Value);
        }
      }
    }
  } catch (error) {
    // Swallow every error: the suite must still exit 0 when no stack is
    // reachable. Log once at a low level for diagnosability.
    console.warn(
      `Live CloudFormation export lookup in ${region} did not complete; ` +
        `flows depending on unresolved values will skip.`,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(timer);
    client.destroy();
  }

  return result;
}

/**
 * Fill any unset {@link StackConfig} field from a map of CloudFormation exports
 * (see {@link EXPORT_MAPPINGS}), without overriding values a higher-precedence
 * source already provided. Returns a new config object.
 */
export function applyExports(
  base: StackConfig,
  exports: Map<string, string>,
): StackConfig {
  const merged: StackConfig = { ...base };
  for (const mapping of EXPORT_MAPPINGS) {
    const existing = merged[mapping.key];
    if (typeof existing === "string" && existing.length > 0) {
      continue; // higher-precedence source already provided this field
    }
    for (const name of mapping.exportNames) {
      const raw = exports.get(name);
      if (typeof raw !== "string" || raw.length === 0) {
        continue;
      }
      const value = mapping.transform ? mapping.transform(raw) : raw;
      if (typeof value === "string" && value.length > 0) {
        merged[mapping.key] = value;
        break;
      }
    }
  }
  return merged;
}

/**
 * Asynchronously resolve the deployed-stack configuration from all three
 * sources in precedence order: individual env vars, then the CDK outputs file
 * (both via {@link loadStackConfig}), then — for anything still unset — the
 * live CloudFormation stack exports.
 *
 * The live query is skipped entirely when {@link loadStackConfig} already
 * resolved every field, when it is disabled via `INTEGRATION_DISABLE_CFN_LOOKUP`,
 * or when no relevant field is missing — so a fully env-configured run does no
 * network I/O. The query is bounded and failure-tolerant (see
 * {@link loadExports}): if CloudFormation is unreachable the returned config is
 * exactly what the synchronous sources produced.
 */
export async function resolveStackConfig(): Promise<StackConfig> {
  const base = loadStackConfig();

  if (liveLookupDisabled()) {
    return base;
  }

  // Only hit CloudFormation if at least one mappable field is still missing.
  const anyMissing = EXPORT_MAPPINGS.some((mapping) => {
    const value = base[mapping.key];
    return typeof value !== "string" || value.length === 0;
  });
  if (!anyMissing) {
    return base;
  }

  const exports = await loadExports(base.region);
  if (exports.size === 0) {
    return base;
  }
  return applyExports(base, exports);
}

/**
 * Async counterpart to {@link gate}: resolve the configuration including the
 * live CloudFormation source, then evaluate the required keys.
 *
 * Use this from an async `beforeAll` (or top-level await) when a flow should
 * run automatically against an already-deployed stack with no env vars /
 * outputs file. Because {@link resolveStackConfig} is bounded and never throws,
 * a flow that calls this still skips gracefully (rather than hanging or
 * failing) when no stack is reachable.
 */
export async function gateAsync(required: StackConfigKey[]): Promise<Gate> {
  const config = await resolveStackConfig();
  return gateFromConfig(config, required);
}
