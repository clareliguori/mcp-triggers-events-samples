/**
 * Unit tests for the briefing report route handlers (task 4.4).
 *
 * The S3 client is mocked with `aws-sdk-client-mock` so the tests exercise the
 * real handler logic (key construction, listing + sorting, `?latest=true`,
 * summary projection, validation, reportId generation) without touching AWS.
 * Covered:
 * - GET by id found / not-found,
 * - GET list (newest-first) and ?latest=true (single most recent),
 * - POST writes report JSON to the per-customer key and returns { reportId },
 * - POST generates a reportId when omitted,
 * - validation 400s (bad ids, bad body, customerId mismatch).
 */

import {
  GetObjectCommand,
  type GetObjectCommandOutput,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { BriefingReport } from "@mcp-events/shared";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createReport,
  getReport,
  listReports,
  setS3ClientForTesting,
} from "./reports.js";
import type { AuthContext, RouteContext } from "../types.js";

const BUCKET = "test-reports-bucket";
const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const REPORT_ID = "22222222-2222-4222-8222-222222222222";

const s3Mock = mockClient(S3Client);

/** A full BriefingReport for the test customer. */
function makeReport(overrides: Partial<BriefingReport> = {}): BriefingReport {
  return {
    reportId: REPORT_ID,
    customerId: CUSTOMER_ID,
    customerDisplayName: "Acme Seismology",
    briefingPrompt: "Summarize notable earthquakes for the Pacific region.",
    generatedAt: "2024-02-01T08:00:00.000Z",
    periodStart: "2024-01-25T08:00:00.000Z",
    periodEnd: "2024-02-01T08:00:00.000Z",
    summary: "A quiet week with a handful of moderate events.",
    totalEarthquakes: 3,
    notableQuakes: [
      {
        earthquakeId: "us7000n123",
        magnitude: 5.2,
        place: "10km SW of Ridgecrest, CA",
        reason: "Largest of the period.",
      },
    ],
    geographicPatterns: "Clustered along the San Andreas fault.",
    comparisonToPrevious: "Slightly more active than the prior week.",
    ...overrides,
  };
}

/** Wrap a JSON string as a mocked S3 streaming body. */
function streamBody(text: string): GetObjectCommandOutput["Body"] {
  return {
    transformToString: async () => text,
  } as unknown as GetObjectCommandOutput["Body"];
}

/** S3 key for a report under the test customer's prefix. */
function key(reportId: string): string {
  return `reports/${CUSTOMER_ID}/${reportId}.json`;
}

/** Build a RouteContext for the report routes. */
function makeContext(opts: {
  method: string;
  customerId?: string;
  reportId?: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
}): RouteContext {
  const auth: AuthContext = {
    authType: "cognito",
    cognitoSub: opts.customerId ?? CUSTOMER_ID,
  };
  const pathParameters: Record<string, string> = {
    customerId: opts.customerId ?? CUSTOMER_ID,
  };
  if (opts.reportId !== undefined) {
    pathParameters.reportId = opts.reportId;
  }
  return {
    event: {} as RouteContext["event"],
    method: opts.method,
    pathParameters,
    query: opts.query ?? {},
    body: opts.body,
    auth,
  };
}

beforeEach(() => {
  s3Mock.reset();
  setS3ClientForTesting(new S3Client({}));
  process.env.REPORTS_BUCKET_NAME = BUCKET;
});

afterEach(() => {
  setS3ClientForTesting(undefined);
  delete process.env.REPORTS_BUCKET_NAME;
});

afterAll(() => {
  s3Mock.restore();
});

describe("getReport", () => {
  it("returns 200 with the full report when found", async () => {
    const report = makeReport();
    s3Mock
      .on(GetObjectCommand)
      .resolves({ Body: streamBody(JSON.stringify(report)) });

    const res = await getReport(
      makeContext({ method: "GET", reportId: REPORT_ID }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(report);

    const call = s3Mock.commandCalls(GetObjectCommand)[0];
    expect(call.args[0].input).toMatchObject({
      Bucket: BUCKET,
      Key: key(REPORT_ID),
    });
  });

  it("throws 404 when the report object is absent", async () => {
    s3Mock
      .on(GetObjectCommand)
      .rejects(new NoSuchKey({ message: "missing", $metadata: {} }));

    await expect(
      getReport(makeContext({ method: "GET", reportId: REPORT_ID })),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("throws 400 for a non-UUID reportId", async () => {
    await expect(
      getReport(makeContext({ method: "GET", reportId: "nope" })),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("listReports", () => {
  const olderId = "33333333-3333-4333-8333-333333333333";
  const newerId = "44444444-4444-4444-8444-444444444444";

  function seedTwoReports(): void {
    const older = makeReport({
      reportId: olderId,
      generatedAt: "2024-01-01T08:00:00.000Z",
    });
    const newer = makeReport({
      reportId: newerId,
      generatedAt: "2024-03-01T08:00:00.000Z",
    });
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: key(olderId) }, { Key: key(newerId) }],
      IsTruncated: false,
    });
    s3Mock
      .on(GetObjectCommand, { Bucket: BUCKET, Key: key(olderId) })
      .resolves({ Body: streamBody(JSON.stringify(older)) });
    s3Mock
      .on(GetObjectCommand, { Bucket: BUCKET, Key: key(newerId) })
      .resolves({ Body: streamBody(JSON.stringify(newer)) });
  }

  it("returns report summaries sorted newest-first", async () => {
    seedTwoReports();

    const res = await listReports(makeContext({ method: "GET" }));

    expect(res.statusCode).toBe(200);
    const body = res.body as { reports: Array<{ reportId: string }> };
    expect(body.reports.map((r) => r.reportId)).toEqual([newerId, olderId]);
    // Summaries are lightweight: no full report fields like notableQuakes.
    expect(body.reports[0]).not.toHaveProperty("notableQuakes");

    const listCall = s3Mock.commandCalls(ListObjectsV2Command)[0];
    expect(listCall.args[0].input).toMatchObject({
      Bucket: BUCKET,
      Prefix: `reports/${CUSTOMER_ID}/`,
    });
  });

  it("returns only the most recent report when ?latest=true", async () => {
    seedTwoReports();

    const res = await listReports(
      makeContext({ method: "GET", query: { latest: "true" } }),
    );

    const body = res.body as { reports: Array<{ reportId: string }> };
    expect(body.reports).toHaveLength(1);
    expect(body.reports[0].reportId).toBe(newerId);
  });

  it("returns an empty list when the customer has no reports", async () => {
    s3Mock
      .on(ListObjectsV2Command)
      .resolves({ Contents: [], IsTruncated: false });

    const res = await listReports(makeContext({ method: "GET" }));

    expect(res.body).toEqual({ reports: [] });
  });

  it("throws 400 for a non-UUID customerId", async () => {
    await expect(
      listReports(makeContext({ method: "GET", customerId: "bad" })),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("createReport", () => {
  it("writes the report JSON to the per-customer key and returns reportId", async () => {
    s3Mock.on(PutObjectCommand).resolves({});

    const res = await createReport(
      makeContext({ method: "POST", body: makeReport() }),
    );

    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ reportId: REPORT_ID });

    const call = s3Mock.commandCalls(PutObjectCommand)[0];
    const input = call.args[0].input;
    expect(input.Bucket).toBe(BUCKET);
    expect(input.Key).toBe(key(REPORT_ID));
    expect(input.ContentType).toBe("application/json");
    const stored = JSON.parse(input.Body as string) as BriefingReport;
    expect(stored.reportId).toBe(REPORT_ID);
    expect(stored.customerId).toBe(CUSTOMER_ID);
  });

  it("generates a reportId when the body omits one", async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const { reportId: _omit, ...withoutId } = makeReport();

    const res = await createReport(
      makeContext({ method: "POST", body: withoutId }),
    );

    const body = res.body as { reportId: string };
    expect(body.reportId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const call = s3Mock.commandCalls(PutObjectCommand)[0];
    expect(call.args[0].input.Key).toBe(key(body.reportId));
  });

  it("returns 400 when the body fails validation", async () => {
    const bad = makeReport({ periodStart: "not-a-date" });

    await expect(
      createReport(makeContext({ method: "POST", body: bad })),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it("returns 400 when the body customerId does not match the path", async () => {
    const mismatched = makeReport({
      customerId: "99999999-9999-4999-8999-999999999999",
    });

    await expect(
      createReport(makeContext({ method: "POST", body: mismatched })),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("returns 400 when the body is not an object", async () => {
    await expect(
      createReport(makeContext({ method: "POST", body: "nope" })),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
