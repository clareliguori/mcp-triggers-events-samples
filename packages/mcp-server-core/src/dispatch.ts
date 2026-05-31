/**
 * Dual-trigger Lambda dispatch shared by both MCP servers.
 *
 * Each MCP server runs on a single Lambda that is triggered two ways: an API
 * Gateway proxy event (served as the MCP HTTP transport, plus any per-server
 * extra REST routes) or an EventBridge scheduled tick (which runs the server's
 * background work — a USGS poll cycle or a schedule check). This module wires
 * those together: the per-server MCP handler, the scheduled work, and any extra
 * routes are supplied as {@link DualTriggerConfig}, and {@link createDualTriggerHandler}
 * returns the Lambda entry point that routes each invocation.
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

import {
  JSON_RPC_INTERNAL_ERROR,
  isApiGatewayEvent,
  jsonRpcErrorResponse,
} from "./mcp-transport.js";

/**
 * An extra API Gateway route served on the same Lambda alongside the MCP
 * transport (e.g. MCP Server 2's manual `POST /trigger-briefing/{customerId}`).
 * When {@link ExtraRoute.match} returns `true` the event is handled by
 * {@link ExtraRoute.handle}; a thrown error is mapped to a response by
 * {@link ExtraRoute.onError}.
 */
export interface ExtraRoute {
  match: (e: APIGatewayProxyEvent) => boolean;
  handle: (e: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;
  onError: (error: unknown) => APIGatewayProxyResult;
}

/** Per-server configuration for the dual-trigger entry point. */
export interface DualTriggerConfig {
  /** The MCP HTTP transport handler (see `createMcpRequestHandler`). */
  mcpHandler: (e: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;
  /** The background work run on an EventBridge tick (poll / schedule check). */
  onSchedule: () => Promise<void>;
  /** Optional extra API Gateway routes, matched before the MCP transport. */
  routes?: ExtraRoute[];
}

/**
 * Build the dual-trigger Lambda entry point. An API Gateway proxy event is first
 * offered to each extra route (in order); the first matching route handles it,
 * with its own error mapping. When no extra route matches, the event falls
 * through to the MCP HTTP transport, whose unhandled errors become a JSON-RPC
 * internal error. A non-API event (the EventBridge scheduled tick) runs the
 * background work and returns no HTTP result.
 */
export function createDualTriggerHandler(
  config: DualTriggerConfig,
): (event: unknown) => Promise<APIGatewayProxyResult | void> {
  const routes = config.routes ?? [];

  return async function handler(
    event: unknown,
  ): Promise<APIGatewayProxyResult | void> {
    if (isApiGatewayEvent(event)) {
      for (const route of routes) {
        if (route.match(event)) {
          try {
            return await route.handle(event);
          } catch (error) {
            return route.onError(error);
          }
        }
      }

      try {
        return await config.mcpHandler(event);
      } catch (error) {
        console.error("Unhandled MCP request error", error);
        return jsonRpcErrorResponse(
          null,
          JSON_RPC_INTERNAL_ERROR,
          "Internal Server Error",
        );
      }
    }

    await config.onSchedule();
  };
}
