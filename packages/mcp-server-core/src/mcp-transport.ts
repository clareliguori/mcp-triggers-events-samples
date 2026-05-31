/**
 * MCP HTTP transport shared by both MCP servers: the JSON-RPC 2.0 plumbing over
 * API Gateway and a factory that builds the `events/list` + `events/subscribe` +
 * `events/unsubscribe` dispatch for a given server configuration.
 *
 * The two servers' MCP surfaces differ only in the declared event type, the
 * accepted event name, the recorded server endpoint, and how the subscribe
 * `inputSchema` maps to per-server domain attributes. Those four knobs are
 * lifted into {@link McpServerConfig}; the validation, error-mapping, customerId
 * extraction, and method dispatch are written once in
 * {@link createMcpRequestHandler}.
 */

import type {
  SubscribeParamsInput,
  WebhookSubscription,
} from "@mcp-events/shared";
import {
  DEFAULT_SUBSCRIPTION_TTL_SECONDS,
  subscribeParamsSchema,
  uuidV4Schema,
} from "@mcp-events/shared";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

import {
  createSubscription,
  deleteSubscription,
} from "./subscription-store.js";

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 error codes + request shape
// ---------------------------------------------------------------------------

/** Standard JSON-RPC 2.0 error codes used by the MCP transport. */
export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

/** Build an API Gateway response carrying a JSON-RPC success result. */
export function jsonRpcResult(
  id: JsonRpcId,
  result: unknown,
): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, result }),
  };
}

/** Build an API Gateway response carrying a JSON-RPC error object. */
export function jsonRpcErrorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }),
  };
}

/** Read the raw request body, decoding API Gateway base64 bodies. */
export function readRawBody(event: APIGatewayProxyEvent): string {
  if (event.body === null || event.body === undefined) {
    return "";
  }
  return event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
}

/** Best-effort JSON parse; returns `undefined` when the text is not JSON. */
export function tryParseJson(text: string): unknown {
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
 * Extract an optional `customerId` extension field from raw subscribe params.
 * The MCP Events protocol does not define it, so it is accepted only when
 * present and a valid UUID v4; an invalid value is reported as invalid params.
 */
export function extractCustomerId(params: unknown): {
  ok: boolean;
  customerId?: string;
} {
  if (
    typeof params !== "object" ||
    params === null ||
    !("customerId" in params)
  ) {
    return { ok: true };
  }
  const value = (params as { customerId?: unknown }).customerId;
  if (value === undefined) {
    return { ok: true };
  }
  const parsed = uuidV4Schema.safeParse(value);
  return parsed.success ? { ok: true, customerId: parsed.data } : { ok: false };
}

// ---------------------------------------------------------------------------
// Dual-trigger entry detection
// ---------------------------------------------------------------------------

/** Whether the invocation is an API Gateway proxy event (vs an EventBridge tick). */
export function isApiGatewayEvent(
  event: unknown,
): event is APIGatewayProxyEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    typeof (event as { httpMethod?: unknown }).httpMethod === "string"
  );
}

// ---------------------------------------------------------------------------
// Per-server MCP request handler factory
// ---------------------------------------------------------------------------

/** Per-server configuration for the MCP `events/*` dispatch. */
export interface McpServerConfig {
  /** The single event type this server declares via `events/list`. */
  eventType: {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: unknown;
  };
  /** The only event name this server accepts on `events/subscribe`. */
  eventName: WebhookSubscription["eventName"];
  /** This server's MCP endpoint, recorded on each created subscription. */
  serverEndpoint: string;
  /**
   * Map the validated subscribe `inputSchema` to the per-server domain
   * attributes stored on the subscription record (only defined keys), e.g.
   * `{ filterParams }` for MCP Server 1 or `{ schedule }` for MCP Server 2.
   */
  mapInputSchema: (
    inputSchema: SubscribeParamsInput["inputSchema"],
  ) => Record<string, unknown>;
}

/**
 * Build the dual MCP HTTP request handler for a server described by `config`.
 * The returned function dispatches a single JSON-RPC request over `POST /mcp`
 * to the matching `events/*` method. Application-level failures are returned as
 * JSON-RPC error objects (HTTP 200), matching JSON-RPC semantics; only an
 * unparseable body yields a transport-level error.
 */
export function createMcpRequestHandler(
  config: McpServerConfig,
): (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult> {
  /** Handle `events/list` (Requirement 14.1/14.2). */
  function handleEventsList(id: JsonRpcId): APIGatewayProxyResult {
    return jsonRpcResult(id, { eventTypes: [config.eventType] });
  }

  /**
   * Handle `events/subscribe` (Requirements 14.3, 14.5, 17.5). Validates the
   * params with the shared zod schema (including the required `whsec_` secret
   * format), rejects events other than this server's, maps `inputSchema` to the
   * per-server domain attributes, and creates the subscription.
   */
  async function handleEventsSubscribe(
    id: JsonRpcId,
    params: unknown,
  ): Promise<APIGatewayProxyResult> {
    const parsed = subscribeParamsSchema.safeParse(params);
    if (!parsed.success) {
      return jsonRpcErrorResponse(
        id,
        JSON_RPC_INVALID_PARAMS,
        `Invalid events/subscribe params: ${parsed.error.issues
          .map((issue) => issue.message)
          .join("; ")}`,
      );
    }

    const data = parsed.data;
    if (data.event !== config.eventName) {
      return jsonRpcErrorResponse(
        id,
        JSON_RPC_INVALID_PARAMS,
        `MCP server only emits ${config.eventName}`,
      );
    }

    const customer = extractCustomerId(params);
    if (!customer.ok) {
      return jsonRpcErrorResponse(
        id,
        JSON_RPC_INVALID_PARAMS,
        "customerId must be a valid UUID v4 when supplied",
      );
    }

    const result = await createSubscription({
      event: data.event,
      callbackUrl: data.delivery.url,
      secret: data.delivery.secret,
      ttlSeconds: data.ttl ?? DEFAULT_SUBSCRIPTION_TTL_SECONDS,
      customerId: customer.customerId,
      serverEndpoint: config.serverEndpoint,
      domainAttributes: config.mapInputSchema(data.inputSchema),
    });

    return jsonRpcResult(id, result);
  }

  /** Handle `events/unsubscribe` — validate the id and delete the record. */
  async function handleEventsUnsubscribe(
    id: JsonRpcId,
    params: unknown,
  ): Promise<APIGatewayProxyResult> {
    const subscriptionId =
      typeof params === "object" && params !== null
        ? (params as { subscriptionId?: unknown }).subscriptionId
        : undefined;

    const parsed = uuidV4Schema.safeParse(subscriptionId);
    if (!parsed.success) {
      return jsonRpcErrorResponse(
        id,
        JSON_RPC_INVALID_PARAMS,
        "subscriptionId must be a valid UUID v4",
      );
    }

    await deleteSubscription(parsed.data);
    return jsonRpcResult(id, { unsubscribed: true });
  }

  /**
   * Dispatch a single MCP JSON-RPC request to the matching `events/*` method.
   */
  return async function handleMcpRequest(
    event: APIGatewayProxyEvent,
  ): Promise<APIGatewayProxyResult> {
    if (event.httpMethod.toUpperCase() !== "POST") {
      return jsonRpcErrorResponse(
        null,
        JSON_RPC_INVALID_REQUEST,
        "MCP transport accepts POST only",
      );
    }

    const raw = readRawBody(event);
    if (raw.length === 0) {
      return jsonRpcErrorResponse(
        null,
        JSON_RPC_INVALID_REQUEST,
        "Empty request",
      );
    }

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(raw) as JsonRpcRequest;
    } catch {
      return jsonRpcErrorResponse(null, JSON_RPC_PARSE_ERROR, "Invalid JSON");
    }

    const id: JsonRpcId =
      typeof request.id === "string" ||
      typeof request.id === "number" ||
      request.id === null
        ? request.id
        : null;

    if (typeof request.method !== "string") {
      return jsonRpcErrorResponse(
        id,
        JSON_RPC_INVALID_REQUEST,
        "Missing JSON-RPC method",
      );
    }

    switch (request.method) {
      case "events/list":
        return handleEventsList(id);
      case "events/subscribe":
        return handleEventsSubscribe(id, request.params);
      case "events/unsubscribe":
        return handleEventsUnsubscribe(id, request.params);
      default:
        return jsonRpcErrorResponse(
          id,
          JSON_RPC_METHOD_NOT_FOUND,
          `Unknown method ${request.method}`,
        );
    }
  };
}
