// CustomerConfig domain types and client-side validation for the self-service
// configuration page (task 12.3, Requirement 10.3).
//
// The webapp is a self-contained static SPA bundle. Rather than importing the
// `@mcp-events/shared` barrel (whose `crypto`/`secret` modules pull in
// `@aws-sdk/client-kms` and `node:crypto`, neither browser-safe), this module
// MIRRORS the server-side rules from `packages/shared/src/{constants,validation}.ts`
// so the form's client-side checks line up with the Data API's zod validation
// (Requirements 16.2-16.5). The Data API remains the source of truth and
// re-validates every request; these checks just give immediate feedback.
//
// This module is intentionally free of `$app/*` / API-client imports so the
// pure validation can be unit/property tested under plain Node (mirroring the
// `config-schema.ts` vs `config.ts` split in the auth module). The Data API
// calls live in `config-api.ts`.

// ---------------------------------------------------------------------------
// Shared domain constants (mirror of @mcp-events/shared/constants)
// ---------------------------------------------------------------------------

/** Allowed earthquake feed regions (Requirement 16.3). */
export const REGIONS = [
  "pacific",
  "americas",
  "europe",
  "asia",
  "africa",
] as const;

export type Region = (typeof REGIONS)[number];

/** Inclusive magnitude bounds (Requirement 16.2). */
export const MIN_MAGNITUDE = 0;
export const MAX_MAGNITUDE = 10;

/** Briefing prompt length bounds (Requirement 16.4). */
export const BRIEFING_PROMPT_MIN_LENGTH = 1;
export const BRIEFING_PROMPT_MAX_LENGTH = 2000;

/** Display name length bounds (mirrors the shared input schema). */
export const DISPLAY_NAME_MIN_LENGTH = 1;
export const DISPLAY_NAME_MAX_LENGTH = 200;

/**
 * 5-field cron expression validator (Requirement 16.5). Mirrors `CRON_REGEX`
 * in the shared package: `minute hour day-of-month month day-of-week`, each
 * field accepting `*`, single values, ranges, step values, and comma lists.
 */
const CRON_FIELD = String.raw`(\*|\d+|\d+-\d+|\*\/\d+|\d+\/\d+)(,(\*|\d+|\d+-\d+|\*\/\d+|\d+\/\d+))*`;
export const CRON_REGEX = new RegExp(`^${CRON_FIELD}( ${CRON_FIELD}){4}$`);

/** Human-friendly labels for the region select options. */
export const REGION_LABELS: Record<Region, string> = {
  pacific: "Pacific",
  americas: "Americas",
  europe: "Europe",
  asia: "Asia",
  africa: "Africa",
};

// ---------------------------------------------------------------------------
// Domain types (mirror of @mcp-events/shared/models)
// ---------------------------------------------------------------------------

export interface SubscriptionParams {
  minMagnitude?: number;
  region?: Region;
  maxDepthKm?: number;
}

/** Request body for `PUT /customers/:customerId/config`. */
export interface CustomerConfigInput {
  displayName: string;
  subscriptionParams: SubscriptionParams;
  briefingPrompt: string;
  briefingSchedule: string;
}

/** Full CustomerConfig as returned by the Data API. */
export interface CustomerConfig extends CustomerConfigInput {
  customerId: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Form model + validation
// ---------------------------------------------------------------------------

/**
 * Form-shaped view of the config. Numeric filter fields are kept as strings so
 * empty inputs map cleanly to "no filter" and partial typing does not throw.
 */
export interface ConfigFormValues {
  displayName: string;
  minMagnitude: string;
  region: Region | "";
  maxDepthKm: string;
  briefingPrompt: string;
  briefingSchedule: string;
}

/** Field-keyed validation errors. */
export type ConfigFormErrors = Partial<Record<keyof ConfigFormValues, string>>;

/** A sensible starting point for a brand-new customer's config form. */
export function emptyConfigForm(): ConfigFormValues {
  return {
    displayName: "",
    minMagnitude: "",
    region: "",
    maxDepthKm: "",
    briefingPrompt: "",
    briefingSchedule: "0 9 * * *",
  };
}

/** Map a CustomerConfig (from the Data API) into form values. */
export function configToForm(config: CustomerConfig): ConfigFormValues {
  const { displayName, subscriptionParams, briefingPrompt, briefingSchedule } =
    config;
  return {
    displayName,
    minMagnitude:
      subscriptionParams.minMagnitude !== undefined
        ? String(subscriptionParams.minMagnitude)
        : "",
    region: subscriptionParams.region ?? "",
    maxDepthKm:
      subscriptionParams.maxDepthKm !== undefined
        ? String(subscriptionParams.maxDepthKm)
        : "",
    briefingPrompt,
    briefingSchedule,
  };
}

/**
 * Validate form values and, on success, produce the {@link CustomerConfigInput}
 * request body. Mirrors the shared zod schema so the user gets immediate
 * feedback; the Data API re-validates server-side (Requirement 16.7).
 */
export function validateConfigForm(
  values: ConfigFormValues,
):
  | { ok: true; value: CustomerConfigInput }
  | { ok: false; errors: ConfigFormErrors } {
  const errors: ConfigFormErrors = {};

  const displayName = values.displayName.trim();
  if (
    displayName.length < DISPLAY_NAME_MIN_LENGTH ||
    displayName.length > DISPLAY_NAME_MAX_LENGTH
  ) {
    errors.displayName = `Display name must be 1-${DISPLAY_NAME_MAX_LENGTH} characters.`;
  }

  const subscriptionParams: SubscriptionParams = {};

  if (values.minMagnitude.trim() !== "") {
    const minMagnitude = Number(values.minMagnitude);
    if (
      Number.isNaN(minMagnitude) ||
      minMagnitude < MIN_MAGNITUDE ||
      minMagnitude > MAX_MAGNITUDE
    ) {
      errors.minMagnitude = `Minimum magnitude must be between ${MIN_MAGNITUDE} and ${MAX_MAGNITUDE}.`;
    } else {
      subscriptionParams.minMagnitude = minMagnitude;
    }
  }

  if (values.region !== "") {
    if (!REGIONS.includes(values.region)) {
      errors.region = "Select a valid region.";
    } else {
      subscriptionParams.region = values.region;
    }
  }

  if (values.maxDepthKm.trim() !== "") {
    const maxDepthKm = Number(values.maxDepthKm);
    if (Number.isNaN(maxDepthKm) || maxDepthKm <= 0) {
      errors.maxDepthKm = "Maximum depth must be a positive number of km.";
    } else {
      subscriptionParams.maxDepthKm = maxDepthKm;
    }
  }

  const briefingPrompt = values.briefingPrompt.trim();
  if (
    briefingPrompt.length < BRIEFING_PROMPT_MIN_LENGTH ||
    briefingPrompt.length > BRIEFING_PROMPT_MAX_LENGTH
  ) {
    errors.briefingPrompt = `Briefing prompt must be 1-${BRIEFING_PROMPT_MAX_LENGTH} characters.`;
  }

  const briefingSchedule = values.briefingSchedule.trim();
  if (!CRON_REGEX.test(briefingSchedule)) {
    errors.briefingSchedule =
      'Briefing schedule must be a valid 5-field cron expression (e.g. "0 9 * * *").';
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      displayName,
      subscriptionParams,
      briefingPrompt,
      briefingSchedule,
    },
  };
}
