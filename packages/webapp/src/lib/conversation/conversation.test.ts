import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  BRIEFING_TRIGGER_MESSAGE,
  EARTHQUAKE_MESSAGE_PREFIX,
  formatTimestamp,
  messagesToTimeline,
  normalizeContentBlocks,
  parseEarthquakeMessage,
  type TimelineItem,
} from "./conversation.js";

// A faithful earthquake user message exactly as the agent's
// `formatEarthquakeUserMessage` renders it (packages/agent/src/accumulate.ts).
function earthquakeMessageText(): string {
  return [
    EARTHQUAKE_MESSAGE_PREFIX,
    "- ID: us6000abcd",
    "- Magnitude: 5.4",
    "- Location: 10km N of Testville",
    "- Time: 2024-01-02T03:04:05.000Z",
    "- Coordinates: 12.34, -56.78",
    "- Depth: 10 km",
    "- Tsunami warning: no",
    "- Felt: 42 reports",
    "- PAGER alert level: green",
    "- More info: https://example.com/eq",
    "",
    "Briefly analyze this earthquake's significance and how it relates to any earlier earthquakes in our conversation.",
  ].join("\n");
}

describe("parseEarthquakeMessage", () => {
  it("parses all salient labeled fields from an earthquake user message", () => {
    const parsed = parseEarthquakeMessage(earthquakeMessageText());
    expect(parsed).toMatchObject({
      earthquakeId: "us6000abcd",
      magnitude: "5.4",
      place: "10km N of Testville",
      time: "2024-01-02T03:04:05.000Z",
      coordinates: "12.34, -56.78",
      depth: "10 km",
      tsunami: "no",
      felt: "42 reports",
      alert: "green",
      url: "https://example.com/eq",
    });
  });

  it("returns an empty object when no known labels are present", () => {
    expect(parseEarthquakeMessage("just some prose with no fields")).toEqual(
      {},
    );
  });
});

describe("normalizeContentBlocks", () => {
  it("wraps a plain string as a single text block", () => {
    expect(normalizeContentBlocks("hello")).toEqual([{ text: "hello" }]);
  });

  it("passes through an array of blocks and drops non-object entries", () => {
    expect(
      normalizeContentBlocks([{ text: "a" }, null, 7, { toolUse: {} }]),
    ).toEqual([{ text: "a" }, { toolUse: {} }]);
  });

  it("returns an empty array for unsupported content", () => {
    expect(normalizeContentBlocks(undefined)).toEqual([]);
    expect(normalizeContentBlocks(42)).toEqual([]);
  });
});

describe("messagesToTimeline", () => {
  it("maps an earthquake user message to an event card item", () => {
    const timeline = messagesToTimeline([
      { role: "user", content: [{ text: earthquakeMessageText() }] },
    ]);
    expect(timeline).toHaveLength(1);
    const item = timeline[0];
    expect(item.kind).toBe("earthquake");
    if (item.kind === "earthquake") {
      expect(item.earthquake.magnitude).toBe("5.4");
      expect(item.earthquake.place).toBe("10km N of Testville");
    }
  });

  it("maps assistant text to a response bubble", () => {
    const timeline = messagesToTimeline([
      { role: "assistant", content: [{ text: "This quake is notable." }] },
    ]);
    expect(timeline).toEqual<TimelineItem[]>([
      { kind: "assistant", id: "0-0", text: "This quake is notable." },
    ]);
  });

  it("splits a multi-block assistant message into separate items", () => {
    // An assistant message can carry BOTH analysis text AND a tool-use block.
    const timeline = messagesToTimeline([
      {
        role: "assistant",
        content: [
          { text: "Synthesizing the period now." },
          {
            toolUse: {
              name: "save_report",
              toolUseId: "tu-1",
              input: { summary: "All quiet" },
            },
          },
        ],
      },
    ]);
    expect(timeline.map((i) => i.kind)).toEqual(["assistant", "tool-use"]);
    const toolUse = timeline[1];
    expect(toolUse.kind).toBe("tool-use");
    if (toolUse.kind === "tool-use") {
      expect(toolUse.toolName).toBe("save_report");
      expect(toolUse.summary).toBe("Generating a briefing report");
    }
  });

  it("maps a tool result with a report id to a success confirmation badge", () => {
    const timeline = messagesToTimeline([
      {
        role: "user",
        content: [
          {
            toolResult: {
              toolUseId: "tu-1",
              status: "success",
              content: [{ json: { saved: true, reportId: "rep-123" } }],
            },
          },
        ],
      },
    ]);
    expect(timeline).toHaveLength(1);
    const item = timeline[0];
    expect(item.kind).toBe("tool-result");
    if (item.kind === "tool-result") {
      expect(item.status).toBe("success");
      expect(item.reportId).toBe("rep-123");
      expect(item.summary).toBe("Report saved");
    }
  });

  it("recognizes the briefing trigger user message distinctly", () => {
    const timeline = messagesToTimeline([
      { role: "user", content: BRIEFING_TRIGGER_MESSAGE },
    ]);
    expect(timeline).toHaveLength(1);
    const item = timeline[0];
    expect(item.kind).toBe("user-text");
    if (item.kind === "user-text") {
      expect(item.isBriefingTrigger).toBe(true);
    }
  });

  it("skips empty/whitespace-only text blocks", () => {
    const timeline = messagesToTimeline([
      { role: "assistant", content: [{ text: "   " }, { text: "" }] },
    ]);
    expect(timeline).toEqual([]);
  });

  it("returns an empty timeline for non-array input", () => {
    expect(messagesToTimeline(undefined)).toEqual([]);
    expect(messagesToTimeline(null)).toEqual([]);
    expect(messagesToTimeline("nope")).toEqual([]);
  });

  it("ignores malformed message entries without throwing", () => {
    const timeline = messagesToTimeline([
      null,
      42,
      { role: "assistant", content: [{ text: "kept" }] },
    ]);
    expect(timeline).toHaveLength(1);
    expect(timeline[0].kind).toBe("assistant");
  });
});

describe("messagesToTimeline (property)", () => {
  // Property: parsing arbitrary message arrays never throws and always yields a
  // well-formed timeline whose items each carry one of the known kinds and a
  // unique id. This guards the view against any malformed/unexpected snapshot
  // shape (Requirement 10.7 — resilient real-time rendering).
  it("never throws and yields well-formed items for arbitrary input", () => {
    const knownKinds = new Set([
      "earthquake",
      "user-text",
      "assistant",
      "tool-use",
      "tool-result",
    ]);
    fc.assert(
      fc.property(fc.anything(), (input) => {
        const timeline = messagesToTimeline(input);
        expect(Array.isArray(timeline)).toBe(true);
        const ids = new Set<string>();
        for (const item of timeline) {
          expect(knownKinds.has(item.kind)).toBe(true);
          expect(typeof item.id).toBe("string");
          ids.add(item.id);
        }
        // Ids are unique (derived from message/block position).
        expect(ids.size).toBe(timeline.length);
      }),
      { numRuns: 200 },
    );
  });

  // Property: any well-formed earthquake user message is always classified as
  // an earthquake event card, and its parsed magnitude round-trips.
  it("always classifies a well-formed earthquake message as an event card", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 10, noNaN: true, noDefaultInfinity: true }),
        fc.string(),
        (magnitude, place) => {
          const text = [
            EARTHQUAKE_MESSAGE_PREFIX,
            `- Magnitude: ${magnitude}`,
            // Keep place on one line so it parses as a single labeled value.
            `- Location: ${place.replace(/\n/g, " ")}`,
          ].join("\n");
          const timeline = messagesToTimeline([
            { role: "user", content: text },
          ]);
          expect(timeline).toHaveLength(1);
          expect(timeline[0].kind).toBe("earthquake");
          if (timeline[0].kind === "earthquake") {
            expect(timeline[0].earthquake.magnitude).toBe(String(magnitude));
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("formatTimestamp", () => {
  it("formats a valid ISO 8601 timestamp into a non-empty human string", () => {
    const out = formatTimestamp("2024-01-02T03:04:05.000Z");
    expect(out).not.toBe("");
    expect(out).not.toBe("2024-01-02T03:04:05.000Z");
  });

  it("returns the original string unchanged when it cannot be parsed", () => {
    expect(formatTimestamp("not a date")).toBe("not a date");
  });
});
