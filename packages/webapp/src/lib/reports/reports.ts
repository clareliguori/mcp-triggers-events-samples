// Briefing report domain types and presentation helpers for the reports view
// (task 12.4, Requirements 10.4, 10.5).
//
// The webapp is a self-contained static SPA bundle. Rather than importing the
// `@mcp-events/shared` barrel (whose `crypto`/`secret` modules pull in
// `@aws-sdk/client-kms` and `node:crypto`, neither browser-safe), this module
// MIRRORS the report shapes from `packages/shared/src/models.ts`
// (`BriefingReport`, `NotableQuake`, `ReportSummary`) so the reports view can
// render them without the non-browser-safe dependencies. The Data API remains
// the source of truth for the data.
//
// This module is intentionally free of `$app/*` / API-client imports so the
// pure presentation helpers can be unit/property tested under plain Node
// (mirroring the `config-schema.ts` vs `config.ts` split in the auth module and
// the `customer-config.ts` vs `config-api.ts` split for config). The Data API
// calls live in `reports-api.ts`.

// ---------------------------------------------------------------------------
// Domain types (mirror of @mcp-events/shared/models)
// ---------------------------------------------------------------------------

/** A significant earthquake highlighted by the LLM in a briefing report. */
export interface NotableQuake {
  earthquakeId: string;
  magnitude: number;
  place: string;
  /** Why this earthquake is notable. */
  reason: string;
}

/**
 * Full briefing report as returned by
 * `GET /customers/:customerId/reports/:reportId`.
 */
export interface BriefingReport {
  /** UUID v4. */
  reportId: string;
  customerId: string;
  customerDisplayName: string;
  briefingPrompt: string;
  /** ISO 8601. */
  generatedAt: string;
  /** ISO 8601 — start of reporting period. */
  periodStart: string;
  /** ISO 8601 — end of reporting period. */
  periodEnd: string;
  /** High-level summary of seismic activity. */
  summary: string;
  totalEarthquakes: number;
  /** Significant earthquakes highlighted by the LLM. */
  notableQuakes: NotableQuake[];
  /** Analysis of geographic clustering. */
  geographicPatterns: string;
  /** How this period compares to the last. */
  comparisonToPrevious: string;
}

/**
 * Lightweight report list item returned by
 * `GET /customers/:customerId/reports`. Does not include the full report body.
 */
export interface ReportSummary {
  reportId: string;
  /** ISO 8601. */
  generatedAt: string;
  /** ISO 8601. */
  periodStart: string;
  /** ISO 8601. */
  periodEnd: string;
  totalEarthquakes: number;
  /** First 200 characters of the full summary. */
  summary: string;
}

/** Response envelope for the report list endpoint. */
export interface ReportListResponse {
  reports: ReportSummary[];
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/**
 * Format an ISO 8601 timestamp for display. Returns the original string
 * unchanged when it cannot be parsed, so malformed data degrades gracefully
 * rather than rendering "Invalid Date".
 */
export function formatTimestamp(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return iso;
  }
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Format the reporting period bounded by two ISO 8601 timestamps as
 * `<start> – <end>`. Each endpoint is formatted via {@link formatTimestamp}.
 */
export function formatPeriod(periodStart: string, periodEnd: string): string {
  return `${formatTimestamp(periodStart)} \u2013 ${formatTimestamp(periodEnd)}`;
}

/**
 * Format an earthquake magnitude to a single decimal place (e.g. `4.5`).
 * Returns `"—"` for non-finite values so partial/malformed data is obvious.
 */
export function formatMagnitude(magnitude: number): string {
  if (!Number.isFinite(magnitude)) {
    return "\u2014";
  }
  return magnitude.toFixed(1);
}
