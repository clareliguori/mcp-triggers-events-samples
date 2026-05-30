/**
 * Unit tests for the manual briefing trigger route handler (task 4.5).
 *
 * The outbound call to MCP Server 2 is replaced with a mock {@link
 * TriggerSender} via the `setTriggerSenderForTesting` seam, so these tests
 * exercise the real handler logic (customerId validation, URL/payload
 * construction, status mapping) without SigV4 signing or network access.
 *
 * Covered:
 * - successful forward (sender 2xx -> 202 with the downstream body),
 * - the outbound request is built correctly (URL, method, JSON payload),
 * - optional `reason` is forwarded when present and omitted otherwise,
 * - downstream failure (sender 5xx -> 502),
 * - non-UUID customerId -> 400,
 * - missing SCHEDULER_MCP_URL env var -> surfaces as an error (handler maps 500).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  setTriggerSenderForTesting,
  triggerBriefing,
  type TriggerRequest,
  type TriggerResponse,
} from "./trigger.js";
import { HttpError } from "../http.js";
import type { AuthContext, RouteContext } from "../types.js";

const SCHEDULER_URL = "https://scheduler-mcp.earthquake-agent.example.com";
const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";

/** Build a RouteContext for the trigger route (Cognito caller by default). */
function makeContext(opts?: {
  customerId?: string;
  body?: unknown;
}): RouteContext {
  const customerId = opts?.customerId ?? CUSTOMER_ID;
  const auth: AuthContext = { authType: "cognito", cognitoSub: customerId };
  return {
    event: {} as RouteContext["event"],
    method: "POST",
    pathParameters: { customerId },
    query: {},
    body: opts?.body,
    auth,
  };
}

beforeEach(() => {
  process.env.SCHEDULER_MCP_URL = SCHEDULER_URL;
});

afterEach(() => {
  setTriggerSenderForTesting(undefined);
  delete process.env.SCHEDULER_MCP_URL;
});

describe("triggerBriefing", () => {
  it("forwards to MCP Server 2 and returns 202 with the downstream body", async () => {
    const downstream = { eventId: "evt-123", delivered: true };
    const sender = vi.fn(
      async (_req: TriggerRequest): Promise<TriggerResponse> => ({
        statusCode: 200,
        body: JSON.stringify(downstream),
      }),
    );
    setTriggerSenderForTesting(sender);

    const res = await triggerBriefing(makeContext());

    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual(downstream);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it("builds the outbound request URL, method, and JSON payload", async () => {
    const sender = vi.fn(
      async (_req: TriggerRequest): Promise<TriggerResponse> => ({
        statusCode: 202,
        body: JSON.stringify({ eventId: "evt-1", delivered: true }),
      }),
    );
    setTriggerSenderForTesting(sender);

    await triggerBriefing(makeContext());

    const sent = sender.mock.calls[0][0];
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe(`${SCHEDULER_URL}/trigger-briefing/${CUSTOMER_ID}`);
    expect(sent.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(sent.body)).toEqual({ customerId: CUSTOMER_ID });
  });

  it("forwards an optional reason when present in the body", async () => {
    const sender = vi.fn(
      async (_req: TriggerRequest): Promise<TriggerResponse> => ({
        statusCode: 200,
        body: "{}",
      }),
    );
    setTriggerSenderForTesting(sender);

    await triggerBriefing(makeContext({ body: { reason: "ad hoc check" } }));

    expect(JSON.parse(sender.mock.calls[0][0].body)).toEqual({
      customerId: CUSTOMER_ID,
      reason: "ad hoc check",
    });
  });

  it("omits reason when it is not a string", async () => {
    const sender = vi.fn(
      async (_req: TriggerRequest): Promise<TriggerResponse> => ({
        statusCode: 200,
        body: "{}",
      }),
    );
    setTriggerSenderForTesting(sender);

    await triggerBriefing(makeContext({ body: { reason: 42 } }));

    expect(JSON.parse(sender.mock.calls[0][0].body)).toEqual({
      customerId: CUSTOMER_ID,
    });
  });

  it("returns 202 with an empty object when the downstream body is not JSON", async () => {
    const sender = vi.fn(
      async (_req: TriggerRequest): Promise<TriggerResponse> => ({
        statusCode: 200,
        body: "",
      }),
    );
    setTriggerSenderForTesting(sender);

    const res = await triggerBriefing(makeContext());

    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({});
  });

  it("maps a 5xx downstream response to 502", async () => {
    const sender = vi.fn(
      async (_req: TriggerRequest): Promise<TriggerResponse> => ({
        statusCode: 503,
        body: "scheduler unavailable",
      }),
    );
    setTriggerSenderForTesting(sender);

    await expect(triggerBriefing(makeContext())).rejects.toMatchObject({
      statusCode: 502,
    });
  });

  it("maps a non-2xx (4xx) downstream response to 502", async () => {
    const sender = vi.fn(
      async (_req: TriggerRequest): Promise<TriggerResponse> => ({
        statusCode: 404,
        body: "no subscription",
      }),
    );
    setTriggerSenderForTesting(sender);

    await expect(triggerBriefing(makeContext())).rejects.toBeInstanceOf(
      HttpError,
    );
  });

  it("throws 400 for a non-UUID customerId without calling the sender", async () => {
    const sender = vi.fn(
      async (_req: TriggerRequest): Promise<TriggerResponse> => ({
        statusCode: 200,
        body: "{}",
      }),
    );
    setTriggerSenderForTesting(sender);

    await expect(
      triggerBriefing(makeContext({ customerId: "not-a-uuid" })),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(sender).not.toHaveBeenCalled();
  });

  it("throws when SCHEDULER_MCP_URL is not set", async () => {
    delete process.env.SCHEDULER_MCP_URL;
    const sender = vi.fn(
      async (_req: TriggerRequest): Promise<TriggerResponse> => ({
        statusCode: 200,
        body: "{}",
      }),
    );
    setTriggerSenderForTesting(sender);

    await expect(triggerBriefing(makeContext())).rejects.toThrow(
      /SCHEDULER_MCP_URL/,
    );
    expect(sender).not.toHaveBeenCalled();
  });
});
