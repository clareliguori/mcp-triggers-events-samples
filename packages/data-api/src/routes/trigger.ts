/**
 * Manual briefing trigger route handler (task 4.5).
 *
 * Route: POST /trigger-briefing/:customerId
 *
 * Forwards a manual briefing trigger to MCP Server 2 (the Message Scheduler),
 * whose non-MCP REST endpoint `POST /trigger-briefing/:customerId` delivers a
 * `briefing.trigger` event immediately for the customer regardless of schedule
 * (Requirements 2.4, 10.5). The Data API is the only webapp-facing caller of
 * that endpoint; the cross-cutting authorization layer (task 4.1) already
 * enforces that a Cognito caller's JWT `sub` equals the `customerId` path
 * parameter before this handler runs, so this module focuses on the outbound
 * call.
 *
 * MCP Server 2's API Gateway uses IAM authorization (server-to-server only),
 * so the outbound request is signed with AWS SigV4 for the `execute-api`
 * service. The MCP Server 2 base URL is a deterministic custom domain
 * (`scheduler-mcp.earthquake-agent.<parentDomain>`) supplied to the Lambda via
 * the `SCHEDULER_MCP_URL` environment variable (see DataApiStack), rather than
 * a cross-stack import, to avoid a synth-time ordering dependency.
 *
 * The outbound signing + HTTP send is hidden behind an injectable {@link
 * TriggerSender} seam so unit tests can exercise this handler without real AWS
 * credentials or network access (see {@link setTriggerSenderForTesting}).
 */

import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@smithy/signature-v4";
import type { HttpRequest } from "@smithy/types";
import { customerIdSchema } from "@mcp-events/shared";

import { HttpError, badRequest } from "../http.js";
import type { ApiResult, RouteContext } from "../types.js";

/** An outbound HTTP request the {@link TriggerSender} must sign and deliver. */
export interface TriggerRequest {
  /** Absolute URL (including path), e.g. `https://scheduler-mcp.../trigger-briefing/<id>`. */
  url: string;
  /** Upper-case HTTP method. */
  method: string;
  /** Request headers (lower-cased keys). */
  headers: Record<string, string>;
  /** Serialized JSON request body. */
  body: string;
}

/** The result of an outbound {@link TriggerRequest}. */
export interface TriggerResponse {
  /** Downstream HTTP status code. */
  statusCode: number;
  /** Raw response body text (may be empty). */
  body: string;
}

/**
 * Sends a (to-be-signed) outbound request to MCP Server 2 and returns its
 * response. The production implementation signs the request with SigV4 and
 * delivers it with `fetch`; tests override it via
 * {@link setTriggerSenderForTesting}.
 */
export type TriggerSender = (req: TriggerRequest) => Promise<TriggerResponse>;

/**
 * SigV4-sign a request for the `execute-api` service and deliver it with the
 * global `fetch` (Node 20+). Credentials come from the Lambda execution role
 * via the default provider chain.
 */
const defaultSender: TriggerSender = async (req) => {
  const url = new URL(req.url);

  const signer = new SignatureV4({
    service: "execute-api",
    region:
      process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
    credentials: defaultProvider(),
    sha256: Sha256,
  });

  const toSign: HttpRequest = {
    method: req.method,
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname,
    // SigV4 sets the `host` header during signing; provide it explicitly too.
    headers: { ...req.headers, host: url.host },
    body: req.body,
  };

  const signed = await signer.sign(toSign);

  const response = await fetch(req.url, {
    method: req.method,
    headers: signed.headers,
    body: req.body,
  });

  return { statusCode: response.status, body: await response.text() };
};

/** Module-level sender singleton (test seam). */
let sender: TriggerSender = defaultSender;

/**
 * Override the outbound {@link TriggerSender}. Test seam only — production code
 * never calls this. Pass `undefined` to reset back to the default SigV4 sender.
 */
export function setTriggerSenderForTesting(
  override: TriggerSender | undefined,
): void {
  sender = override ?? defaultSender;
}

/** Resolve the MCP Server 2 base URL from the environment. */
function schedulerMcpUrl(): string {
  const url = process.env.SCHEDULER_MCP_URL;
  if (!url) {
    // Misconfiguration — surfaces as a 500 via the handler's catch-all.
    throw new Error("SCHEDULER_MCP_URL is not set");
  }
  return url;
}

/**
 * Validate and return the `customerId` path parameter.
 *
 * @throws HttpError 400 when it is missing or not a UUID (the `customerId`
 *   is the Cognito `sub`, a UUID but not necessarily v4).
 */
function requireCustomerId(ctx: RouteContext): string {
  const result = customerIdSchema.safeParse(ctx.pathParameters.customerId);
  if (!result.success) {
    throw badRequest("customerId must be a valid UUID");
  }
  return result.data;
}

/**
 * Extract the optional `reason` from the request body, when the body is an
 * object carrying a string `reason` (used to annotate manual triggers). A
 * missing or non-string `reason` is simply omitted.
 */
function extractReason(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null && "reason" in body) {
    const reason = (body as { reason?: unknown }).reason;
    if (typeof reason === "string") {
      return reason;
    }
  }
  return undefined;
}

/** Best-effort JSON parse; returns `undefined` when the text is not JSON. */
function tryParseJson(text: string): unknown {
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * POST /trigger-briefing/:customerId — forward a manual briefing trigger to MCP
 * Server 2 via an IAM-signed HTTP request (Requirements 2.4, 10.5).
 *
 * Returns 202 Accepted with MCP Server 2's response body (the
 * `{ eventId, delivered }` ManualTriggerEndpoint contract) on a 2xx downstream
 * response. A non-2xx downstream response is mapped to 502 Bad Gateway so the
 * webapp can distinguish an upstream failure from a client error.
 */
export async function triggerBriefing(ctx: RouteContext): Promise<ApiResult> {
  const customerId = requireCustomerId(ctx);
  const baseUrl = schedulerMcpUrl().replace(/\/+$/, "");

  const reason = extractReason(ctx.body);
  const payload: { customerId: string; reason?: string } = { customerId };
  if (reason !== undefined) {
    payload.reason = reason;
  }

  const response = await sender({
    url: `${baseUrl}/trigger-briefing/${encodeURIComponent(customerId)}`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    console.error("Manual trigger upstream failure", {
      customerId,
      upstreamStatus: response.statusCode,
      upstreamBody: response.body,
    });
    throw new HttpError(502, "Briefing trigger failed - please try again");
  }

  const parsed = tryParseJson(response.body);
  return { statusCode: 202, body: parsed ?? {} };
}
