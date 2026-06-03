/**
 * Lambda adapter for the MCP SDK's McpServer + WebStandardStreamableHTTPServerTransport.
 *
 * Bridges API Gateway proxy events to the SDK's web-standard Request/Response
 * interface, enabling McpServer to run in a serverless Lambda. Each invocation
 * creates a fresh transport (stateless mode) and connects it to the shared
 * server instance. The server instance persists across invocations so
 * registered events and the subscription store remain available for emitEvent.
 */

import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

/**
 * Convert an API Gateway proxy event to a web-standard Request.
 */
function toWebRequest(event: APIGatewayProxyEvent): Request {
  const protocol = event.headers?.["X-Forwarded-Proto"] ?? "https";
  const host = event.headers?.Host ?? event.headers?.host ?? "localhost";
  const path = event.path ?? "/";
  const url = `${protocol}://${host}${path}`;

  const headers = new Headers();
  if (event.headers) {
    for (const [key, value] of Object.entries(event.headers)) {
      if (value) headers.set(key, value);
    }
  }

  const body =
    event.body !== null && event.body !== undefined
      ? event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf8")
        : event.body
      : undefined;

  return new Request(url, {
    method: event.httpMethod,
    headers,
    body: body ?? null,
  });
}

/**
 * Convert a web-standard Response to an API Gateway proxy result.
 */
async function toApiGatewayResult(
  response: Response,
): Promise<APIGatewayProxyResult> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = await response.text();
  return {
    statusCode: response.status,
    headers,
    body,
  };
}

/**
 * Create an API Gateway Lambda handler that serves the MCP protocol via
 * the SDK's streamable HTTP transport. Each invocation creates a fresh
 * transport connected to the shared server instance. The server is NOT
 * closed between invocations so registered events persist.
 */
export function createMcpLambdaHandler(
  server: McpServer,
): (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult> {
  return async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no session tracking
      enableJsonResponse: true, // return JSON instead of SSE for Lambda compatibility
    });

    await server.connect(transport);

    try {
      const request = toWebRequest(event);
      const response = await transport.handleRequest(request);
      return toApiGatewayResult(response);
    } finally {
      await transport.close();
    }
  };
}
