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

```
USGS API ──poll──> MCP Server 1 ─┐
                                 ├─signed webhook─> Webhook Receiver ─> SQS ─> Agent (Strands)
              MCP Server 2 ──────┘                                              │
                                                                                ├─> Bedrock (LLM)
Webapp ──Cognito JWT──> Data API <──IAM SigV4── Agent ───S3 (sessions) <────────┘
                          │                     └──────> S3 (reports, via Data API)
Subscription Manager ──IAM──> MCP Server 1 + MCP Server 2 (events/subscribe), Data API (records)
```

- **MCP servers** declare event types, manage per-customer webhook
  subscriptions, and sign deliveries with Standard Webhooks HMAC-SHA256.
- **MCP client/host** (the agent, webhook receiver, and subscription manager
  together) subscribes to events, routes each delivery to the right customer by
  `X-MCP-Subscription-Id`, and processes it.
- **Webhook signing secrets are per-subscription and client-generated**: the
  Subscription Manager generates a `whsec_` secret per subscription and supplies
  it on `events/subscribe`. Secrets are stored client-side-encrypted with
  per-table KMS keys (see [Security notes](#security-notes)).

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
