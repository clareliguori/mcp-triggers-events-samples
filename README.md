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

## Repository layout

This is a TypeScript (ESM, NodeNext) monorepo managed with **npm workspaces**.

| Package                         | Purpose                                                                                                                                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`               | Data models, zod validation, constants, Standard Webhooks helpers, and KMS encrypt/decrypt helpers shared across packages.                                                                     |
| `packages/mcp-server-core`      | Shared MCP server machinery reused by both servers: AWS client singletons, env lookups, subscription store, signed webhook delivery, JSON-RPC MCP transport, and dual-trigger Lambda dispatch. |
| `packages/usgs-server`          | MCP Server 1 — USGS feed poller, per-subscription filter, and MCP/webhook Lambda handler.                                                                                                      |
| `packages/scheduler-server`     | MCP Server 2 — cron schedule evaluation, manual trigger, and MCP/webhook Lambda handler.                                                                                                       |
| `packages/webhook-receiver`     | Validates Standard Webhooks signatures and enqueues events to SQS with the subscription id as a message attribute.                                                                             |
| `packages/agent`                | The serverless Strands agent: SQS handler, customer routing, distributed lock, earthquake accumulation, briefing generation, and corrupted-session recovery.                                   |
| `packages/subscription-manager` | Creates subscriptions for new customers (DynamoDB Stream) and refreshes expiring ones (EventBridge).                                                                                           |
| `packages/data-api`             | Shared persistence API (API Gateway + Lambda) for customer config, subscriptions, reports, and a read-only session-messages view. Dual auth: Cognito (webapp) + IAM (backend).                 |
| `packages/webapp`               | SvelteKit SPA (static adapter) styled with shadcn-svelte + Tailwind, authenticated via Cognito Hosted UI (authorization code + PKCE).                                                          |
| `packages/cdk`                  | Multi-stack AWS CDK app that deploys the whole system.                                                                                                                                         |
| `packages/integration-tests`    | Black-box end-to-end tests against a deployed stack (skip gracefully when nothing is deployed).                                                                                                |

### CDK stacks (`packages/cdk/lib`)

`bin/app.ts` instantiates ten stacks:

| Stack                      | Region    | Responsibility                                                                                                    |
| -------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| `DnsRegionalStack`         | target    | Subdomain hosted zone, NS delegation, regional wildcard ACM cert for the API Gateway custom domains.              |
| `DnsUsEast1Stack`          | us-east-1 | Wildcard ACM cert for CloudFront and Cognito (which require us-east-1 certs).                                     |
| `AuthStack`                | target    | Cognito User Pool + Hosted UI domain.                                                                             |
| `DataApiStack`             | target    | Data API (API GW + Lambda), CustomerConfig + Subscriptions DynamoDB tables, reports S3 bucket, per-table KMS key. |
| `UsgsServerStack`          | target    | MCP Server 1 (IAM-auth API GW), cursor + subscriptions tables, KMS key, EventBridge poll (5 min).                 |
| `SchedulerServerStack`     | target    | MCP Server 2 (IAM-auth API GW), subscriptions table, KMS key, EventBridge check (1 min).                          |
| `WebhookReceiverStack`     | target    | Webhook API GW, SQS event queue + DLQ, DLQ-depth alarm.                                                           |
| `AgentStack`               | target    | Agent Lambda (SQS trigger, batch size 1), sessions S3 bucket, DynamoDB locks table.                               |
| `SubscriptionManagerStack` | target    | Subscription Manager Lambda (DynamoDB Stream + EventBridge triggers).                                             |
| `WebappStack`              | target    | SPA S3 bucket + CloudFront (OAC) at `app.<subdomain>.<parentDomain>`.                                             |

## Prerequisites

- **Node.js >= 20** and npm.
- An **AWS account** with credentials configured for the target region.
- **Amazon Bedrock model access** for the agent's LLM (default
  `us.anthropic.claude-haiku-4-5-20251001-v1:0`; override with the
  `BEDROCK_MODEL_ID` env var on the agent Lambda).
- A **Route53 public hosted zone you already own** for the parent domain. The
  default is `liguori.people.aws.dev`; override it at synth/deploy time with
  `-c parentDomain=example.com`. The app creates the
  `earthquake-agent.<parentDomain>` subdomain zone and NS delegation for you.
- **CDK bootstrap** in both the target region and `us-east-1` (the DNS/TLS
  foundation is split across the two because CloudFront/Cognito certs must live
  in us-east-1).

## Install

```bash
npm install
```

This installs all workspaces. Shared dependencies (CDK, Strands SDK, MCP SDK,
zod, etc.) are hoisted to the root `package.json`.

The MCP SDK (`@modelcontextprotocol/server` and `@modelcontextprotocol/core`)
is installed from vendored tarballs in `vendor/` — these are built from a
[fork](https://github.com/clareliguori/mcp-typescript-sdk/tree/events-bufferemits-and-examples)
of the upstream MCP TypeScript SDK that adds serverless support
(`WebhookSubscriptionStore` interface, `serverless` mode, and `flush()`). To
regenerate the tarballs after updating the fork:

```bash
cd ~/code/mcp/typescript-sdk
pnpm install && pnpm -r build
pnpm --filter @modelcontextprotocol/core pack --pack-destination /tmp/mcp-sdk-packs/
pnpm --filter @modelcontextprotocol/server pack --pack-destination /tmp/mcp-sdk-packs/
cp /tmp/mcp-sdk-packs/*.tgz ~/code/mcp-triggers-events-samples/vendor/
cd ~/code/mcp-triggers-events-samples && npm install
```

## Build

```bash
npm run build       # tsc --build across all referenced packages
npm run typecheck   # same as build (composite project references)
npm run clean       # tsc --build --clean
```

The webapp is built with Vite, not the root `tsc --build`, and is not part of
the root TypeScript project references:

```bash
npm run build --workspace @mcp-events/webapp   # vite build -> static SPA
npm run check --workspace @mcp-events/webapp   # svelte-check type checking
```

## Lint

```bash
npm run lint        # eslint . (flat config, type-checked rules)
npm run lint:fix
```

The root ESLint config ignores `packages/webapp/**` (it has its own
svelte-check tooling), build artifacts, and `cdk.out`.

## Test

Unit and property tests use **vitest** with **fast-check** (property tests are
named `*.property.test.ts`).

```bash
npm test                          # vitest run across the monorepo
npx vitest run packages/agent     # a single package
```

The webapp has no `test` npm script; its framework-agnostic unit tests
(`src/**/*.test.ts`, primarily the auth/PKCE/JWT logic) run under their own
`vitest.config.ts`:

```bash
cd packages/webapp && npx vitest run   # webapp unit tests
```

Component/store tests that depend on SvelteKit `$app/*` aliases are validated via
`npm run check` and `npm run build` instead.

Integration tests run black-box against a **deployed** stack and skip when no
stack is reachable (so they always exit 0 in CI):

```bash
npx vitest run packages/integration-tests
```

With a stack deployed and AWS credentials available, the suite auto-discovers
endpoints from the `EarthquakeAgent-*` CloudFormation exports. See
`packages/integration-tests/README.md` for env-var and outputs-file
alternatives and the IAM permissions required.

## Synthesize and deploy

The CDK app builds itself (`tsc --build`) before synthesizing — its `cdk.json`
`app` command is `npx tsc --build && node dist/bin/app.js`.

```bash
cd packages/cdk

# Synthesize all stacks (uses the default parent domain)
npm run synth
#   or override the parent domain:
npx cdk synth -c parentDomain=example.com

# Deploy everything (creates exporters before importers via explicit deps)
npm run deploy
#   equivalent to:
npx cdk deploy --all -c parentDomain=example.com
```

`CDK_DEFAULT_ACCOUNT` and `CDK_DEFAULT_REGION` (populated by the AWS CLI) select
the account and target region; `DnsUsEast1Stack` is always pinned to us-east-1.

To run the integration tests against a fresh deploy, capture the outputs:

```bash
npx cdk deploy --all --outputs-file cdk-outputs.json
CDK_OUTPUTS_FILE=$PWD/cdk-outputs.json npx vitest run packages/integration-tests
```

## Run / use the system

Once deployed:

1. Create a user. Self sign-up is disabled on the Cognito User Pool, so an
   administrator invites users with the AWS CLI. Sign-in uses the email address
   as the username. Resolve the pool id from the `EarthquakeAgent-UserPoolId`
   stack export, then invite the user — Cognito emails a temporary password and
   forces a password change on first sign-in:

   ```bash
   USER_POOL_ID=$(aws cloudformation list-exports --no-cli-pager \
     --query "Exports[?Name=='EarthquakeAgent-UserPoolId'].Value" --output text)

   aws cognito-idp admin-create-user --no-cli-pager \
     --user-pool-id "$USER_POOL_ID" \
     --username you@example.com \
     --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true \
     --desired-delivery-mediums EMAIL
   ```

   The temporary and chosen passwords must meet the pool policy (at least 12
   characters with lowercase, uppercase, and digit characters). To skip the
   force-change step (for example a throwaway test user), instead set a
   permanent password with
   `aws cognito-idp admin-set-user-password --user-pool-id "$USER_POOL_ID" --username you@example.com --password 'PermanentPassword123' --permanent`.

2. Open the webapp at `https://app.earthquake-agent.<parentDomain>` and sign in
   via the Cognito Hosted UI with that email and password.
3. Configure a subscription (display name, min magnitude, region, max depth,
   briefing prompt, briefing schedule). Saving writes a `CustomerConfig`, whose
   DynamoDB Stream triggers the Subscription Manager to create subscriptions on
   both MCP servers.
4. MCP Server 1 polls USGS every 5 minutes and delivers matching earthquakes;
   the agent analyzes each one in your isolated session.
5. Use **Trigger Briefing Now** (or wait for your schedule) to generate a
   report. Read reports and the live conversation timeline in the webapp.

For local webapp development:

```bash
npm run dev --workspace @mcp-events/webapp   # vite dev server on :5173
```

The Data API allows the `http://localhost:5173` webapp dev origin (CORS) in
addition to the CloudFront origin, so the local dev server can call the deployed
Data API from the browser without any extra configuration.

To point the dev server at a deployed backend, create a gitignored
`packages/webapp/config.local.json` (copy `config.local.example.json`) with the
real Cognito/Data API values; the dev server serves it at `/config.json` in
place of the committed placeholder. See AGENTS.md for the full Playwright
testing workflow.

## Security notes

- **Webhook auth**: every delivery is signed with a per-subscription Standard
  Webhooks `whsec_` secret. The Subscription Manager (the MCP client) generates
  the secret and supplies it on `events/subscribe`; the servers never generate
  it.
- **Secret storage**: each of the three Subscriptions tables (Data API, USGS,
  Scheduler) has its own customer-managed KMS key with rotation enabled. Secrets
  are stored client-side encrypted (bound to `subscriptionId` via a KMS
  encryption context); only ciphertext is ever at rest. The **Data API**
  encrypts/decrypts at its storage boundary and exchanges plaintext with the
  Subscription Manager and Webhook Receiver over IAM-authenticated HTTPS, so
  those two components hold **no** KMS permissions. The MCP servers
  encrypt/decrypt their own table's secret directly. No KMS key is shared or
  granted across stacks.
- **Data API authorization**: webapp requests use a Cognito User Pool
  authorizer (the `customerId` in the path must match the JWT `sub`); backend
  services (agent, subscription manager) use IAM SigV4 against dedicated
  IAM-authorized `/backend/...` routes.
- **Customer isolation**: sessions and reports are prefixed by `customerId`; the
  agent only touches the customer resolved from the subscription lookup, and
  serializes session writes with a DynamoDB distributed lock.

## Tech stack

TypeScript 5.7 (ESM/NodeNext) · AWS CDK 2.230 · Strands Agents SDK · Amazon
Bedrock · Model Context Protocol SDK + `@aws/run-mcp-servers-with-aws-lambda`
(SigV4 transport) · DynamoDB · S3 · SQS · API Gateway · Cognito · CloudFront ·
KMS · `standardwebhooks` · `@deliveryhero/dynamodb-lock` · zod · vitest +
fast-check · SvelteKit 5 + shadcn-svelte + Tailwind.

## License

Apache-2.0.
