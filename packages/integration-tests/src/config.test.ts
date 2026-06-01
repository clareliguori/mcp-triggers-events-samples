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
  gate,
  loadStackConfig,
  queueUrlFromArn,
  requireField,
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
  "CDK_OUTPUTS_FILE",
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
