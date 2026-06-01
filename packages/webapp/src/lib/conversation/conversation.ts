// Conversation history domain types and presentation helpers for the agent
// conversation view (task 12.5, Requirement 10.7).
//
// The webapp is a self-contained static SPA bundle, so — exactly like
// `reports.ts` — this module MIRRORS the message shapes the agent persists
// rather than importing `@mcp-events/shared` (whose `crypto`/`secret` modules
// pull in non-browser-safe `@aws-sdk/client-kms` / `node:crypto`).
//
// The Data API endpoint `GET /customers/:customerId/session/messages` returns
// the `messages` array extracted verbatim from the agent's Strands SDK session
// snapshot (see `packages/data-api/src/routes/session.ts`). Each entry is the
// SDK `MessageData` shape:
//
//   { role: "user" | "assistant", content: ContentBlockData[], metadata?: ... }
//
// where `content` is an array of discriminated-union content blocks keyed by
// their type — a text block is `{ text: string }`, a tool-use block is
// `{ toolUse: { name, toolUseId, input } }`, and a tool-result block is
// `{ toolResult: { toolUseId, status, content } }` (see the SDK's
// `types/messages.d.ts`). A single message can carry MULTIPLE blocks (e.g. an
// assistant message with a text block AND a `save_report` tool-use block), so
// this module flattens messages into a flat list of {@link TimelineItem}s, one
// per renderable block, and maps each to one of the four visual treatments the
// view renders:
//
//   - earthquake user-message injection -> event card  ({@link EarthquakeItem})
//   - assistant analysis text           -> response bubble ({@link AssistantItem})
//   - `save_report` tool-use            -> action card  ({@link ToolUseItem})
//   - tool result                       -> confirmation badge ({@link ToolResultItem})
//
// It also tolerates the simplified design `ConversationMessage` shape
// (`content: string | ToolUseContent[]`) and any malformed entry, degrading to
// a sensible item rather than throwing, because the snapshot is written by a
// separate component and the view auto-refreshes against live data.
//
// This module is intentionally free of `$app/*` / API-client imports so the
// pure parsing/presentation helpers can be unit/property tested under plain
// Node (mirroring the `reports.ts` vs `reports-api.ts` split). The Data API
// call lives in `conversation-api.ts`.

// ---------------------------------------------------------------------------
// Raw message shapes (mirror of the Strands SDK `MessageData`)
// ---------------------------------------------------------------------------

/** A raw content block as persisted in the session snapshot. */
export type RawContentBlock = Record<string, unknown>;

/**
 * A raw conversation message as returned by
 * `GET /customers/:customerId/session/messages`. The role is the SDK's
 * `'user' | 'assistant'`; tool results arrive as `user` messages and tool uses
 * as `assistant` messages. `content` is normally an array of content blocks but
 * may be a plain string under the simplified design shape — both are handled.
 */
export interface RawConversationMessage {
  role?: unknown;
  content?: unknown;
  metadata?: unknown;
}

// ---------------------------------------------------------------------------
// Parsed earthquake (from the agent's earthquake user-message injection)
// ---------------------------------------------------------------------------

/**
 * The leading line of an earthquake observation user message, written by the
 * agent's `formatEarthquakeUserMessage` (packages/agent/src/accumulate.ts).
 * Used to recognize which user messages are earthquake injections.
 */
export const EARTHQUAKE_MESSAGE_PREFIX = "A new earthquake has been detected:";

/**
 * The trigger message the agent injects to prompt briefing synthesis
 * (packages/agent/src/briefing.ts). Recognized so it renders as a distinct
 * "briefing requested" user item rather than a generic text bubble.
 */
export const BRIEFING_TRIGGER_MESSAGE =
  "Generate your periodic briefing report now.";

/**
 * Salient earthquake fields parsed out of the agent's earthquake user message.
 * Every field is optional so a partially-formatted (or future-reformatted)
 * message still renders whatever could be recovered.
 */
export interface ParsedEarthquake {
  earthquakeId?: string;
  /** Magnitude as written in the message (kept as text for faithful display). */
  magnitude?: string;
  place?: string;
  /** Event time as written in the message (ISO 8601). */
  time?: string;
  coordinates?: string;
  depth?: string;
  tsunami?: string;
  felt?: string;
  alert?: string;
  url?: string;
}

/** Map of the labeled lines (`- Label: value`) to the {@link ParsedEarthquake} keys. */
const EARTHQUAKE_FIELD_LABELS: Record<string, keyof ParsedEarthquake> = {
  ID: "earthquakeId",
  Magnitude: "magnitude",
  Location: "place",
  Time: "time",
  Coordinates: "coordinates",
  Depth: "depth",
  "Tsunami warning": "tsunami",
  Felt: "felt",
  "PAGER alert level": "alert",
  "More info": "url",
};

/**
 * Parse the salient fields out of an earthquake observation user message. The
 * agent renders these as `- <Label>: <value>` lines (see
 * `formatEarthquakeUserMessage`); this recovers each known label into the
 * matching {@link ParsedEarthquake} field. Returns an empty object when no
 * known fields are present so callers can still render the raw text.
 */
export function parseEarthquakeMessage(text: string): ParsedEarthquake {
  const parsed: ParsedEarthquake = {};
  for (const line of text.split("\n")) {
    const match = /^-\s*([^:]+):\s*(.*)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    const [, label, value] = match;
    const key = EARTHQUAKE_FIELD_LABELS[label.trim()];
    if (key && value.trim() !== "") {
      parsed[key] = value.trim();
    }
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Timeline items (one per renderable content block)
// ---------------------------------------------------------------------------

/** Discriminator for the four visual treatments in the conversation timeline. */
export type TimelineItemKind =
  | "earthquake"
  | "user-text"
  | "assistant"
  | "tool-use"
  | "tool-result";

/** An earthquake event injection — rendered as an event card. */
export interface EarthquakeItem {
  kind: "earthquake";
  /** Stable list key (derived from position). */
  id: string;
  earthquake: ParsedEarthquake;
  /** The full raw user-message text, for a details/expanded view. */
  raw: string;
}

/**
 * A non-earthquake user message — e.g. the briefing trigger prompt. Rendered as
 * a muted user bubble. `isBriefingTrigger` marks the known trigger message so
 * the view can label it distinctly.
 */
export interface UserTextItem {
  kind: "user-text";
  id: string;
  text: string;
  isBriefingTrigger: boolean;
}

/** Assistant analysis text — rendered as an agent response bubble. */
export interface AssistantItem {
  kind: "assistant";
  id: string;
  text: string;
}

/** A tool invocation (e.g. `save_report`) — rendered as an action card. */
export interface ToolUseItem {
  kind: "tool-use";
  id: string;
  toolName: string;
  /** The raw tool input (e.g. the report narrative fields). */
  input: unknown;
  /** A short human-readable summary of the action. */
  summary: string;
}

/** A tool result — rendered as a confirmation badge. */
export interface ToolResultItem {
  kind: "tool-result";
  id: string;
  status: "success" | "error";
  /** Short human-readable result summary. */
  summary: string;
  /** The saved report id, when the tool result carried one. */
  reportId?: string;
}

/** One renderable entry in the conversation timeline. */
export type TimelineItem =
  | EarthquakeItem
  | UserTextItem
  | AssistantItem
  | ToolUseItem
  | ToolResultItem;

// ---------------------------------------------------------------------------
// Content-block normalization
// ---------------------------------------------------------------------------

/** Return `value` as a record when it is a non-null object, else `undefined`. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Normalize a message's `content` into an array of raw content blocks.
 *
 * - SDK shape: `content` is already `ContentBlockData[]` — returned as-is.
 * - Simplified design shape: `content` is a plain `string` — wrapped as a
 *   single `{ text }` block.
 * - Anything else yields an empty array.
 */
export function normalizeContentBlocks(content: unknown): RawContentBlock[] {
  if (typeof content === "string") {
    return [{ text: content }];
  }
  if (Array.isArray(content)) {
    return content.filter(
      (block): block is RawContentBlock => asRecord(block) !== undefined,
    );
  }
  return [];
}

/** Extract the plain text from a `{ text: string }` block, else `undefined`. */
function textOf(block: RawContentBlock): string | undefined {
  return typeof block.text === "string" ? block.text : undefined;
}

/** A normalized tool-use block (`{ toolUse: {...} }`). */
interface NormalizedToolUse {
  name: string;
  input: unknown;
}

/** Extract a tool-use block (`{ toolUse: {...} }`), else `undefined`. */
function toolUseOf(block: RawContentBlock): NormalizedToolUse | undefined {
  const toolUse = asRecord(block.toolUse);
  if (!toolUse) {
    return undefined;
  }
  return {
    name: typeof toolUse.name === "string" ? toolUse.name : "tool",
    input: toolUse.input,
  };
}

/** A normalized tool-result block (`{ toolResult: {...} }`). */
interface NormalizedToolResult {
  status: "success" | "error";
  content: unknown[];
}

/** Extract a tool-result block (`{ toolResult: {...} }`), else `undefined`. */
function toolResultOf(
  block: RawContentBlock,
): NormalizedToolResult | undefined {
  const toolResult = asRecord(block.toolResult);
  if (!toolResult) {
    return undefined;
  }
  return {
    status: toolResult.status === "error" ? "error" : "success",
    content: Array.isArray(toolResult.content) ? toolResult.content : [],
  };
}

/**
 * Recover the saved report id from a tool-result's content blocks. The
 * `save_report` callback returns `{ saved, reportId }`, which the SDK persists
 * as a JSON block (`{ json: { reportId } }`) or, defensively, a text block.
 */
function reportIdFromToolResult(content: unknown[]): string | undefined {
  for (const entry of content) {
    const record = asRecord(entry);
    if (!record) {
      continue;
    }
    const json = asRecord(record.json);
    if (json && typeof json.reportId === "string") {
      return json.reportId;
    }
    // Defensive: some shapes nest the structured value directly.
    if (typeof record.reportId === "string") {
      return record.reportId;
    }
  }
  return undefined;
}

/** Build a short human-readable summary for a tool-use action card. */
function summarizeToolUse(name: string): string {
  if (name === "save_report") {
    return "Generating a briefing report";
  }
  return `Running ${name}`;
}

// ---------------------------------------------------------------------------
// Timeline construction
// ---------------------------------------------------------------------------

/**
 * Flatten raw conversation messages into a flat {@link TimelineItem} list, one
 * item per renderable content block, mapping each to its visual treatment.
 *
 * Mapping rules (derived from how the agent writes the session):
 * - `user` text starting with {@link EARTHQUAKE_MESSAGE_PREFIX} -> earthquake
 *   event card; the {@link BRIEFING_TRIGGER_MESSAGE} and any other user text ->
 *   user-text bubble.
 * - `assistant` text -> agent response bubble.
 * - `toolUse` block (in an assistant message) -> action card.
 * - `toolResult` block (in a user message) -> confirmation badge.
 *
 * Empty text blocks are skipped so blank padding never renders an empty bubble.
 * Unknown block types (reasoning, media, cache points, …) are ignored.
 */
export function messagesToTimeline(messages: unknown): TimelineItem[] {
  if (!Array.isArray(messages)) {
    return [];
  }

  const items: TimelineItem[] = [];

  messages.forEach((rawMessage, messageIndex) => {
    const message = asRecord(rawMessage) as RawConversationMessage | undefined;
    if (!message) {
      return;
    }
    const role = message.role === "assistant" ? "assistant" : "user";
    const blocks = normalizeContentBlocks(message.content);

    blocks.forEach((block, blockIndex) => {
      const id = `${messageIndex}-${blockIndex}`;

      const toolUse = toolUseOf(block);
      if (toolUse) {
        items.push({
          kind: "tool-use",
          id,
          toolName: toolUse.name,
          input: toolUse.input,
          summary: summarizeToolUse(toolUse.name),
        });
        return;
      }

      const toolResult = toolResultOf(block);
      if (toolResult) {
        const reportId = reportIdFromToolResult(toolResult.content);
        items.push({
          kind: "tool-result",
          id,
          status: toolResult.status,
          summary:
            toolResult.status === "error"
              ? "Action failed"
              : reportId
                ? "Report saved"
                : "Action completed",
          ...(reportId !== undefined && { reportId }),
        });
        return;
      }

      const text = textOf(block);
      if (text === undefined || text.trim() === "") {
        return;
      }

      if (role === "assistant") {
        items.push({ kind: "assistant", id, text });
        return;
      }

      // role === "user"
      if (text.startsWith(EARTHQUAKE_MESSAGE_PREFIX)) {
        items.push({
          kind: "earthquake",
          id,
          earthquake: parseEarthquakeMessage(text),
          raw: text,
        });
        return;
      }

      items.push({
        kind: "user-text",
        id,
        text,
        isBriefingTrigger: text.trim() === BRIEFING_TRIGGER_MESSAGE,
      });
    });
  });

  return items;
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/**
 * Format an ISO 8601 timestamp for display. Returns the original string
 * unchanged when it cannot be parsed, so malformed data degrades gracefully
 * rather than rendering "Invalid Date". Mirrors `reports.ts#formatTimestamp`
 * (kept local so this module stays import-free for Node testing).
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
