# MCP Events Serverless Agent — Earthquake Monitoring

A sample that demonstrates the experimental **MCP Events extension** (webhook
delivery mode) by using it to wake a **serverless** [Strands](https://strandsagents.com)
agent. The agent has zero running compute until an event arrives: two MCP
servers deliver events over signed webhooks, which wake a Lambda-hosted Strands
agent just long enough to process the event and persist its state.

The demo use case is multi-customer earthquake monitoring:

- **MCP Server 1 — USGS Earthquake Feed** polls the USGS GeoJSON feed, detects
  new earthquakes with cursor-based deduplication, and delivers each one as an
  `earthquake.detected` event to every subscription whose filter (minimum
  magnitude, region, max depth) matches.
- **MCP Server 2 — Message Scheduler** fires a `briefing.trigger` event per
  customer on that customer's cron schedule (or on demand).
- A **Strands agent** wakes on each event. The agent's **conversation history is
  the accumulator**: each earthquake becomes a user message plus an LLM analysis
  response; each briefing trigger asks the LLM to synthesize the whole
  conversation into a report via a `save_report` tool.

Each customer has independent subscriptions, an isolated agent session, a custom
briefing prompt, and their own reports. A SvelteKit webapp lets customers
self-service their configuration and read their reports and conversation
history.

> This is sample/demo code intended to illustrate the MCP Events extension and a
> wake/sleep serverless agent pattern. It is not production-hardened.

## Architecture

The system has three components, grouped by their MCP role:

- **MCP Servers** — declare event types, manage webhook subscriptions, deliver signed events
- **MCP Client/Host application** — subscribes to events, receives and processes them, manages customer state
- **External systems** — USGS API, Amazon Bedrock

<img src="diagrams/1-overview.png" alt="High-level overview" width="700">

### Event delivery

Both MCP servers run as Lambda functions on EventBridge schedules. They have
no long-running processes — they wake, check for work, deliver webhooks, and
exit. The agent likewise has zero running compute until a webhook arrives.


<img src="diagrams/2-event-delivery.png" alt="Event delivery flow">
Each delivery is a signed HTTP POST (Standard Webhooks HMAC-SHA256) with an
`X-MCP-Subscription-Id` header that the receiver uses to look up the correct
per-subscription secret and route the event to the right customer.

### Subscription management

The Subscription Manager is the MCP client's subscription lifecycle owner. It
calls `events/subscribe` on both servers per customer — supplying filter
parameters (magnitude, region, depth) for the earthquake feed, a cron schedule
for the briefing trigger, and a client-generated `whsec_` signing secret for
each subscription.

<img src="diagrams/3-subscriptions.png" alt="Subscription management" width="500">

### How the agent processes events

The agent's **conversation history is the accumulator**: each earthquake becomes
a user message + LLM analysis response. On a briefing trigger, the LLM
synthesizes the full conversation into a report via a `save_report` tool call.
Each customer has an isolated session in S3, a distributed lock for write
serialization, and their own reports.

## Getting started

See [DEVELOPMENT.md](DEVELOPMENT.md) for prerequisites, install, build, lint,
test, deploy, and usage instructions.

## MCP Events design coverage

See [MCP-EVENTS-COVERAGE.md](MCP-EVENTS-COVERAGE.md) for a detailed breakdown
of which parts of the
[MCP Events design sketch](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/pja/design-sketch/docs/design-sketch-proposal.md)
are implemented in this project.

## License

Apache-2.0.
