/**
 * Unit tests for the integration-suite configuration loader and skip guard
 * (task 13.2).
 *
 * These tests always run (they exercise no deployed stack), so the
 * `packages/integration-tests` suite is meaningfully green even when no stack
 * is configured: they prove the env-var / CDK-outputs-file resolution and the
 * {@link gate} skip logic behave correctly, which is what lets every e2e flow
 * skip safely rather than fail when the stack endpoints are absent.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyExports,
  gate,
  gateFromConfig,
  loadStackConfig,
  queueUrlFromArn,
  requireField,
  resolveStackConfig,
  type StackConfig,
  type StackConfigKey,
} from "./config.js";

/** Every environment variable the loader consults, cleared between tests. */
const STACK_ENV_VARS = [
  "DATA_API_URL",
  "WEBHOOK_URL",
  "USGS_MCP_URL",
  "SCHEDULER_MCP_URL",
  "SESSIONS_BUCKET_NAME",
  "REPORTS_BUCKET_NAME",
  "EVENT_QUEUE_URL",
  "DEAD_LETTER_QUEUE_URL",
  "CUSTOMER_CONFIG_TABLE_NAME",
  "CDK_OUTPUTS_FILE",
  "INTEGRATION_DISABLE_CFN_LOOKUP",
  "INTEGRATION_CFN_TIMEOUT_MS",
] as const;

let savedEnv: Record<string, string | undefined>;
let tempDir: string | undefined;

beforeEach(() => {
  savedEnv = {};
  for (const key of STACK_ENV_VARS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of STACK_ENV_VARS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

/** Write a CDK outputs JSON file to a fresh temp dir and return its path. */
function writeOutputsFile(outputs: unknown): string {
  tempDir = mkdtempSync(join(tmpdir(), "it-outputs-"));
  const path = join(tempDir, "outputs.json");
  writeFileSync(path, JSON.stringify(outputs), "utf8");
  return path;
}

describe("queueUrlFromArn", () => {
  it("derives an HTTPS queue URL from a well-formed SQS ARN", () => {
    expect(queueUrlFromArn("arn:aws:sqs:us-west-2:123456789012:my-dlq")).toBe(
      "https://sqs.us-west-2.amazonaws.com/123456789012/my-dlq",
    );
  });

  it("returns undefined for non-SQS or malformed ARNs", () => {
    expect(queueUrlFromArn(undefined)).toBeUndefined();
    expect(queueUrlFromArn("not-an-arn")).toBeUndefined();
    expect(
      queueUrlFromArn("arn:aws:s3:us-west-2:123456789012:bucket"),
    ).toBeUndefined();
  });
});

describe("loadStackConfig — environment variables", () => {
  it("reads individual endpoint env vars", () => {
    process.env.DATA_API_URL = "https://api.example.com";
    process.env.WEBHOOK_URL = "https://webhook.example.com";
    process.env.EVENT_QUEUE_URL =
      "https://sqs.us-east-1.amazonaws.com/111/events";

    const config = loadStackConfig();
    expect(config.dataApiUrl).toBe("https://api.example.com");
    expect(config.webhookUrl).toBe("https://webhook.example.com");
    expect(config.eventQueueUrl).toBe(
      "https://sqs.us-east-1.amazonaws.com/111/events",
    );
    // Unset values stay undefined.
    expect(config.reportsBucketName).toBeUndefined();
  });
});

describe("loadStackConfig — CDK outputs file", () => {
  it("maps stack outputs onto the config (and derives the DLQ URL from its ARN)", () => {
    const path = writeOutputsFile({
      DataApiStack: {
        DataApiCustomDomainUrl: "https://api.earthquake-agent.example.com",
        ReportsBucketName: "reports-bucket",
        CustomerConfigTableName: "DataApiStack-CustomerConfig",
      },
      WebhookReceiverStack: {
        WebhookCustomDomainUrl: "https://webhook.earthquake-agent.example.com",
        WebhookQueueUrl: "https://sqs.us-east-1.amazonaws.com/222/events",
        WebhookDeadLetterQueueArn: "arn:aws:sqs:us-east-1:222:events-dlq",
      },
      AgentStack: { SessionsBucketName: "sessions-bucket" },
    });
    process.env.CDK_OUTPUTS_FILE = path;

    const config = loadStackConfig();
    expect(config.dataApiUrl).toBe("https://api.earthquake-agent.example.com");
    expect(config.webhookUrl).toBe(
      "https://webhook.earthquake-agent.example.com",
    );
    expect(config.reportsBucketName).toBe("reports-bucket");
    expect(config.sessionsBucketName).toBe("sessions-bucket");
    expect(config.eventQueueUrl).toBe(
      "https://sqs.us-east-1.amazonaws.com/222/events",
    );
    expect(config.deadLetterQueueUrl).toBe(
      "https://sqs.us-east-1.amazonaws.com/222/events-dlq",
    );
    expect(config.customerConfigTableName).toBe("DataApiStack-CustomerConfig");
  });

  it("lets an explicit env var override the outputs file", () => {
    const path = writeOutputsFile({
      DataApiStack: { DataApiCustomDomainUrl: "https://from-outputs.example" },
    });
    process.env.CDK_OUTPUTS_FILE = path;
    process.env.DATA_API_URL = "https://from-env.example";

    expect(loadStackConfig().dataApiUrl).toBe("https://from-env.example");
  });

  it("falls back to env vars when the outputs file is unreadable", () => {
    process.env.CDK_OUTPUTS_FILE = join(tmpdir(), "does-not-exist-xyz.json");
    process.env.DATA_API_URL = "https://api.example.com";

    expect(loadStackConfig().dataApiUrl).toBe("https://api.example.com");
  });
});

describe("gate — skip-when-not-deployed guard", () => {
  it("does not run when required keys are missing, listing them", () => {
    const required: StackConfigKey[] = ["dataApiUrl", "webhookUrl"];
    const result = gate(required);
    expect(result.shouldRun).toBe(false);
    expect(result.missing).toEqual(["dataApiUrl", "webhookUrl"]);
  });

  it("runs once every required key is present", () => {
    process.env.DATA_API_URL = "https://api.example.com";
    process.env.WEBHOOK_URL = "https://webhook.example.com";

    const result = gate(["dataApiUrl", "webhookUrl"]);
    expect(result.shouldRun).toBe(true);
    expect(result.missing).toEqual([]);
    expect(requireField(result.config, "dataApiUrl")).toBe(
      "https://api.example.com",
    );
  });

  it("requireField throws for an absent field", () => {
    const result = gate(["dataApiUrl"]);
    expect(() => requireField(result.config, "dataApiUrl")).toThrow(/not set/);
  });
});

describe("applyExports — live CloudFormation export mapping", () => {
  const baseConfig: StackConfig = { region: "us-east-1" };

  it("fills every field from its EarthquakeAgent- export (deriving the DLQ URL)", () => {
    const exports = new Map<string, string>([
      [
        "EarthquakeAgent-DataApiCustomDomainUrl",
        "https://api.earthquake-agent.example.com",
      ],
      [
        "EarthquakeAgent-WebhookCustomDomainUrl",
        "https://webhook.earthquake-agent.example.com",
      ],
      [
        "EarthquakeAgent-UsgsMcpCustomDomainUrl",
        "https://usgs-mcp.earthquake-agent.example.com",
      ],
      [
        "EarthquakeAgent-SchedulerMcpCustomDomainUrl",
        "https://scheduler-mcp.earthquake-agent.example.com",
      ],
      ["EarthquakeAgent-SessionsBucketName", "sessions-bucket"],
      ["EarthquakeAgent-ReportsBucketName", "reports-bucket"],
      [
        "EarthquakeAgent-WebhookQueueUrl",
        "https://sqs.us-east-1.amazonaws.com/333/events",
      ],
      [
        "EarthquakeAgent-WebhookDeadLetterQueueArn",
        "arn:aws:sqs:us-east-1:333:events-dlq",
      ],
      [
        "EarthquakeAgent-CustomerConfigTableName",
        "DataApiStack-CustomerConfig",
      ],
    ]);

    const config = applyExports(baseConfig, exports);
    expect(config.dataApiUrl).toBe("https://api.earthquake-agent.example.com");
    expect(config.webhookUrl).toBe(
      "https://webhook.earthquake-agent.example.com",
    );
    expect(config.usgsMcpUrl).toBe(
      "https://usgs-mcp.earthquake-agent.example.com",
    );
    expect(config.schedulerMcpUrl).toBe(
      "https://scheduler-mcp.earthquake-agent.example.com",
    );
    expect(config.sessionsBucketName).toBe("sessions-bucket");
    expect(config.reportsBucketName).toBe("reports-bucket");
    expect(config.eventQueueUrl).toBe(
      "https://sqs.us-east-1.amazonaws.com/333/events",
    );
    expect(config.deadLetterQueueUrl).toBe(
      "https://sqs.us-east-1.amazonaws.com/333/events-dlq",
    );
    expect(config.customerConfigTableName).toBe("DataApiStack-CustomerConfig");
  });

  it("falls back to the plain invoke-URL export for the MCP/Data API URLs", () => {
    const exports = new Map<string, string>([
      ["EarthquakeAgent-DataApiUrl", "https://abc.execute-api.test/prod/"],
      ["EarthquakeAgent-UsgsMcpApiUrl", "https://usgs.execute-api.test/prod/"],
      [
        "EarthquakeAgent-SchedulerMcpApiUrl",
        "https://sched.execute-api.test/prod/",
      ],
    ]);

    const config = applyExports(baseConfig, exports);
    expect(config.dataApiUrl).toBe("https://abc.execute-api.test/prod/");
    expect(config.usgsMcpUrl).toBe("https://usgs.execute-api.test/prod/");
    expect(config.schedulerMcpUrl).toBe("https://sched.execute-api.test/prod/");
  });

  it("prefers the custom-domain export over the invoke-URL fallback", () => {
    const exports = new Map<string, string>([
      ["EarthquakeAgent-DataApiCustomDomainUrl", "https://custom.example.com"],
      ["EarthquakeAgent-DataApiUrl", "https://invoke.execute-api.test/prod/"],
    ]);
    expect(applyExports(baseConfig, exports).dataApiUrl).toBe(
      "https://custom.example.com",
    );
  });

  it("does not override a field a higher-precedence source already set", () => {
    const withEnv: StackConfig = {
      region: "us-east-1",
      dataApiUrl: "https://from-env.example",
    };
    const exports = new Map<string, string>([
      ["EarthquakeAgent-DataApiCustomDomainUrl", "https://from-cfn.example"],
    ]);
    expect(applyExports(withEnv, exports).dataApiUrl).toBe(
      "https://from-env.example",
    );
  });

  it("leaves fields with no matching export undefined", () => {
    const config = applyExports(baseConfig, new Map());
    expect(config.dataApiUrl).toBeUndefined();
    expect(config.deadLetterQueueUrl).toBeUndefined();
  });
});

describe("gateFromConfig — evaluate against a resolved config", () => {
  it("runs when required keys are present and skips otherwise", () => {
    const config: StackConfig = {
      region: "us-east-1",
      dataApiUrl: "https://api.example.com",
    };
    expect(gateFromConfig(config, ["dataApiUrl"]).shouldRun).toBe(true);

    const gateResult = gateFromConfig(config, ["dataApiUrl", "webhookUrl"]);
    expect(gateResult.shouldRun).toBe(false);
    expect(gateResult.missing).toEqual(["webhookUrl"]);
  });
});

describe("resolveStackConfig — live lookup is failsafe and opt-out", () => {
  it("returns the sync config without querying when the lookup is disabled", async () => {
    process.env.INTEGRATION_DISABLE_CFN_LOOKUP = "1";
    process.env.DATA_API_URL = "https://api.example.com";

    const config = await resolveStackConfig();
    expect(config.dataApiUrl).toBe("https://api.example.com");
    // Fields with no env/outputs source stay undefined (no live fill).
    expect(config.webhookUrl).toBeUndefined();
  });

  it("does not query CloudFormation when env vars already satisfy every field", async () => {
    process.env.INTEGRATION_DISABLE_CFN_LOOKUP = "1";
    process.env.DATA_API_URL = "https://api.example.com";
    process.env.WEBHOOK_URL = "https://webhook.example.com";

    const result = gateFromConfig(await resolveStackConfig(), [
      "dataApiUrl",
      "webhookUrl",
    ]);
    expect(result.shouldRun).toBe(true);
  });

  it("returns gracefully (no throw, bounded) when a live lookup is attempted with no reachable stack", async () => {
    // Live lookup enabled (default), but force a tiny timeout and an
    // unroutable endpoint so the bounded query fails fast and contributes
    // nothing rather than hanging or throwing.
    const awsVars = [
      "AWS_REGION",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_ENDPOINT_URL_CLOUDFORMATION",
    ] as const;
    const savedAws: Record<string, string | undefined> = {};
    for (const key of awsVars) {
      savedAws[key] = process.env[key];
    }
    process.env.INTEGRATION_CFN_TIMEOUT_MS = "200";
    process.env.AWS_REGION = "us-east-1";
    process.env.AWS_ACCESS_KEY_ID = "AKIAINTEGRATIONTESTONLY";
    process.env.AWS_SECRET_ACCESS_KEY = "integration-test-only-secret";
    process.env.AWS_ENDPOINT_URL_CLOUDFORMATION = "https://127.0.0.1:1";

    try {
      const start = Date.now();
      const config = await resolveStackConfig();
      const elapsed = Date.now() - start;
      // Nothing resolved, and it returned promptly within a small multiple of
      // the configured timeout (proving it is bounded and never hangs).
      expect(config.dataApiUrl).toBeUndefined();
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      for (const key of awsVars) {
        if (savedAws[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = savedAws[key];
        }
      }
    }
  });
});
