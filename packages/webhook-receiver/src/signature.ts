/**
 * Standard Webhooks signature library for the Webhook Receiver (task 5.1).
 *
 * The sign/verify implementation now lives in the shared package
 * (`@mcp-events/shared`) so both the MCP servers (sign) and the Webhook
 * Receiver (verify) use the exact same Standard Webhooks helper. This module is
 * a thin re-export that preserves the receiver's existing import surface
 * (`import { ... } from "./signature.js"`) for the handler and the property/
 * unit tests.
 *
 * Validates Requirements 3.1, 3.2, 3.3, 17.1.
 */

export {
  MCP_SUBSCRIPTION_ID_HEADER,
  signWebhook,
  verifyWebhook,
  isTimestampWithinTolerance,
  getSubscriptionId,
} from "@mcp-events/shared";
export type {
  WebhookHeaders,
  SignWebhookOptions,
  WebhookRejectionReason,
  WebhookVerificationResult,
} from "@mcp-events/shared";
