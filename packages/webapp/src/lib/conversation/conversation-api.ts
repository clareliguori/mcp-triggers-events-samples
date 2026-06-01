// Data API call for the agent conversation history view (task 12.5,
// Requirement 10.7).
//
// Kept separate from `conversation.ts` so the pure types/parsing/presentation
// helpers there can be unit/property tested under plain Node without dragging
// in the API client's `$app/*` dependency (mirrors the reports module's
// `reports.ts` vs `reports-api.ts` split). The Bearer JWT is attached by the
// shared API client.

import { apiRequest } from "$lib/api/client.js";
import {
  messagesToTimeline,
  type RawConversationMessage,
  type TimelineItem,
} from "./conversation.js";

/** Response envelope for the session messages endpoint. */
interface SessionMessagesResponse {
  messages: RawConversationMessage[];
}

/**
 * GET the agent's conversation history for a customer
 * (`GET /customers/:customerId/session/messages`) and flatten it into a
 * renderable {@link TimelineItem} list.
 *
 * The Data API always returns `{ messages: [...] }` (an empty array when the
 * customer has no session yet — see `packages/data-api/src/routes/session.ts`),
 * so this resolves to an empty timeline rather than throwing for a brand-new
 * customer.
 *
 * @param signal optional {@link AbortSignal} so the auto-refresh poller can
 *   cancel an in-flight request (passed through to the shared API client).
 */
export async function fetchConversation(
  customerId: string,
  signal?: AbortSignal,
): Promise<TimelineItem[]> {
  const response = await apiRequest<SessionMessagesResponse>(
    "GET",
    `/customers/${customerId}/session/messages`,
    { signal },
  );
  return messagesToTimeline(response?.messages ?? []);
}
