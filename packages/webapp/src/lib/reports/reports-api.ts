// Data API calls for briefing reports and manual triggers (task 12.4,
// Requirements 10.4, 10.5).
//
// Kept separate from `reports.ts` so the pure types/presentation helpers there
// can be unit/property tested under plain Node without dragging in the API
// client's `$app/*` dependency (mirrors the config module's `customer-config.ts`
// vs `config-api.ts` split). The Bearer JWT is attached by the shared API
// client.

import { apiRequest } from "$lib/api/client.js";
import type {
  BriefingReport,
  ReportListResponse,
  ReportSummary,
} from "./reports.js";

/**
 * GET the list of briefing report summaries for a customer
 * (`GET /customers/:customerId/reports`), newest-first. Returns an empty array
 * when the customer has no reports yet.
 */
export async function fetchReports(
  customerId: string,
): Promise<ReportSummary[]> {
  const response = await apiRequest<ReportListResponse>(
    "GET",
    `/customers/${customerId}/reports`,
  );
  return response?.reports ?? [];
}

/**
 * GET a single full briefing report
 * (`GET /customers/:customerId/reports/:reportId`); `null` when it does not
 * exist (404).
 */
export async function fetchReport(
  customerId: string,
  reportId: string,
): Promise<BriefingReport | null> {
  try {
    return await apiRequest<BriefingReport>(
      "GET",
      `/customers/${customerId}/reports/${reportId}`,
    );
  } catch (err) {
    if (isNotFound(err)) {
      return null;
    }
    throw err;
  }
}

/**
 * POST a manual briefing trigger (`POST /trigger-briefing/:customerId`,
 * Requirement 10.5). The Data API forwards this to MCP Server 2, which delivers
 * a `briefing.trigger` event immediately regardless of schedule. Resolves once
 * the trigger is accepted (HTTP 202).
 */
export async function triggerBriefing(customerId: string): Promise<void> {
  await apiRequest("POST", `/trigger-briefing/${customerId}`);
}

/** Narrow an unknown error to "the resource was not found" (HTTP 404). */
function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: unknown }).status === 404
  );
}
