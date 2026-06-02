/**
 * Briefing report route handlers (task 4.4).
 *
 * Routes:
 * - GET  /customers/:customerId/reports            (supports ?latest=true)
 * - GET  /customers/:customerId/reports/:reportId
 * - POST /customers/:customerId/reports
 *
 * Reports are stored as JSON in S3 at `reports/{customerId}/{reportId}.json`
 * (Requirement 9.6). The bucket name is supplied by the CDK stack via the
 * `REPORTS_BUCKET_NAME` environment variable.
 *
 * Behavior (Requirements 9.6, 9.7):
 * - GET list   — read every report under the customer's prefix, project each to
 *                a lightweight {@link ReportSummary}, and return them sorted
 *                newest-first by `generatedAt`. `?latest=true` returns only the
 *                most recent report (a single-element list).
 * - GET by id  — read and return the full {@link BriefingReport}; 404 when the
 *                object is absent.
 * - POST       — validate the body (400 on failure), generating a `reportId`
 *                when the caller does not supply one, write the report JSON, and
 *                return `{ reportId }`.
 *
 * Authorization (Cognito `sub` == `customerId`, or an IAM backend caller) is
 * enforced by the handler before dispatch, so these handlers focus on
 * validation and persistence. `customerId` is still validated as a UUID v4
 * here (Requirement 16.1).
 */

import { randomUUID } from "node:crypto";

import {
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { BriefingReport, ReportSummary } from "@mcp-events/shared";
import {
  briefingReportSchema,
  customerIdSchema,
  uuidV4Schema,
} from "@mcp-events/shared";
import { z } from "zod";

import { badRequest, notFound } from "../http.js";
import type { ApiResult, RouteContext } from "../types.js";

/** First N characters of a report summary kept in a {@link ReportSummary}. */
const SUMMARY_PREVIEW_LENGTH = 200;

/**
 * Lazily-created S3 client (module-level singleton so the Lambda reuses one
 * client across warm invocations).
 */
let s3Client: S3Client | undefined;

/** Return the shared {@link S3Client}, creating it on first use. */
function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({});
  }
  return s3Client;
}

/**
 * Override the S3 client. Test seam only — production code never calls this.
 * Pass `undefined` to reset to the lazily-created client.
 */
export function setS3ClientForTesting(client: S3Client | undefined): void {
  s3Client = client;
}

/** Resolve the reports bucket name from the environment. */
function bucketName(): string {
  const name = process.env.REPORTS_BUCKET_NAME;
  if (!name) {
    throw new Error("REPORTS_BUCKET_NAME is not set");
  }
  return name;
}

/** S3 key for a customer's report. */
function reportKey(customerId: string, reportId: string): string {
  return `reports/${customerId}/${reportId}.json`;
}

/** S3 key prefix for all of a customer's reports. */
function reportPrefix(customerId: string): string {
  return `reports/${customerId}/`;
}

/** Flatten a {@link z.ZodError} into a single human-readable message. */
function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

/**
 * Validate and return the `customerId` path parameter.
 *
 * @throws HttpError 400 when it is missing or not a UUID (Requirement 16.1).
 */
function requireCustomerId(ctx: RouteContext): string {
  const result = customerIdSchema.safeParse(ctx.pathParameters.customerId);
  if (!result.success) {
    throw badRequest("customerId must be a valid UUID");
  }
  return result.data;
}

/**
 * Validate and return the `reportId` path parameter.
 *
 * @throws HttpError 400 when it is missing or not a UUID v4.
 */
function requireReportId(ctx: RouteContext): string {
  const result = uuidV4Schema.safeParse(ctx.pathParameters.reportId);
  if (!result.success) {
    throw badRequest("reportId must be a valid UUID v4");
  }
  return result.data;
}

/** Project a full report to its lightweight list representation. */
function toSummary(report: BriefingReport): ReportSummary {
  return {
    reportId: report.reportId,
    generatedAt: report.generatedAt,
    periodStart: report.periodStart,
    periodEnd: report.periodEnd,
    totalEarthquakes: report.totalEarthquakes,
    summary: report.summary.slice(0, SUMMARY_PREVIEW_LENGTH),
  };
}

/** Read and JSON-parse a single report object; returns `undefined` when absent. */
async function readReport(
  customerId: string,
  reportId: string,
): Promise<BriefingReport | undefined> {
  try {
    const result = await getS3Client().send(
      new GetObjectCommand({
        Bucket: bucketName(),
        Key: reportKey(customerId, reportId),
      }),
    );
    const text = (await result.Body?.transformToString()) ?? "";
    return JSON.parse(text) as BriefingReport;
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

/** Whether an S3 error represents a missing object. */
function isNotFound(error: unknown): boolean {
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

/** Extract the `reportId` from an S3 key (`reports/{customerId}/{reportId}.json`). */
function reportIdFromKey(key: string): string | undefined {
  const match = /\/([^/]+)\.json$/.exec(key);
  return match?.[1];
}

/**
 * GET /customers/:customerId/reports — list a customer's report summaries.
 *
 * Reports are returned newest-first by `generatedAt`. `?latest=true` returns
 * only the most recent report as a single-element list.
 */
export async function listReports(ctx: RouteContext): Promise<ApiResult> {
  const customerId = requireCustomerId(ctx);
  const latestOnly = ctx.query.latest === "true";

  // Page through the customer's report objects.
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const listing = await getS3Client().send(
      new ListObjectsV2Command({
        Bucket: bucketName(),
        Prefix: reportPrefix(customerId),
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

  // Read each report body and project to a summary.
  const reports = await Promise.all(
    keys.map(async (key) => {
      const reportId = reportIdFromKey(key);
      if (!reportId) {
        return undefined;
      }
      const report = await readReport(customerId, reportId);
      return report ? toSummary(report) : undefined;
    }),
  );

  const summaries = reports
    .filter((r): r is ReportSummary => r !== undefined)
    .sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt));

  return {
    statusCode: 200,
    body: { reports: latestOnly ? summaries.slice(0, 1) : summaries },
  };
}

/**
 * GET /customers/:customerId/reports/:reportId — read a full report.
 *
 * Returns the {@link BriefingReport} JSON; 404 when the object does not exist.
 */
export async function getReport(ctx: RouteContext): Promise<ApiResult> {
  const customerId = requireCustomerId(ctx);
  const reportId = requireReportId(ctx);

  const report = await readReport(customerId, reportId);
  if (!report) {
    throw notFound(`No report ${reportId} for customer ${customerId}`);
  }

  return { statusCode: 200, body: report };
}

/**
 * POST /customers/:customerId/reports — write a report to S3.
 *
 * Generates a `reportId` when the caller omits one, validates the resulting
 * report (400 on failure), enforces that the body `customerId` matches the
 * path, writes the JSON to `reports/{customerId}/{reportId}.json`, and returns
 * `{ reportId }`.
 */
export async function createReport(ctx: RouteContext): Promise<ApiResult> {
  const customerId = requireCustomerId(ctx);

  if (typeof ctx.body !== "object" || ctx.body === null) {
    throw badRequest("request body must be a JSON object");
  }

  // Fill in a reportId when the caller did not supply one, then validate the
  // full report against the shared schema.
  const candidate = ctx.body as Record<string, unknown>;
  const reportId =
    typeof candidate.reportId === "string" && candidate.reportId.length > 0
      ? candidate.reportId
      : randomUUID();

  const parsed = briefingReportSchema.safeParse({ ...candidate, reportId });
  if (!parsed.success) {
    throw badRequest(formatZodError(parsed.error));
  }
  const report = parsed.data;

  if (report.customerId !== customerId) {
    throw badRequest("body customerId does not match path customerId");
  }

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: reportKey(customerId, report.reportId),
      Body: JSON.stringify(report),
      ContentType: "application/json",
    }),
  );

  return { statusCode: 201, body: { reportId: report.reportId } };
}
