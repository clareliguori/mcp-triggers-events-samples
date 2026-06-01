# @mcp-events/integration-tests

End-to-end integration tests that exercise a **deployed** MCP Events Serverless
Agent stack as a black box (spec task 13.2). They drive the real, deployed
surfaces:

- the IAM-authorized **Data API** (config, subscriptions, reports, session
  messages),
- the **Webhook Receiver** (Standard Webhooks delivery),
- the **SQS** event and dead-letter queues, and
- the **sessions** and **reports** S3 buckets.

## Flows covered

| Flow                  | What it verifies                                                          | Requirements  |
| --------------------- | ------------------------------------------------------------------------- | ------------- |
| Customer registration | Creating a config produces subscriptions on both MCP servers              | 8.1           |
| Earthquake event flow | A signed earthquake webhook accumulates in the correct customer's session | 3.1, 4.1, 4.4 |
| Briefing trigger flow | Triggering a briefing writes a report to S3                               | 4.5           |
| Customer isolation    | Customer A's events never appear in customer B's session                  | 5.1, 5.2      |
| Subscription refresh  | An expiring subscription is refreshed with a later `expiresAt`            | 8.2           |
| DLQ behavior          | An un-routable delivery lands on the dead-letter queue                    | 15.2, 15.6    |

## Skip-when-not-deployed guard

These tests need live endpoints and AWS credentials, which are usually absent
(for example in CI with no deployed stack). Each flow declares the stack
endpoints / resources it requires and **skips gracefully** (`describe.skip`)
when any are missing, so:

```bash
npx vitest run packages/integration-tests
```

**always exits 0**: with no stack configured the e2e flows are reported as
skipped (and the configuration unit tests still run and pass); with a stack
configured the same command runs the flows for real.

## Configuration

Provide the stack's endpoints and resource names with **either** individual
environment variables **or** a CDK outputs file. Individual environment
variables take precedence.

### Option A — environment variables

| Variable                | Purpose                                |
| ----------------------- | -------------------------------------- |
| `DATA_API_URL`          | Data API base URL                      |
| `WEBHOOK_URL`           | Webhook Receiver delivery endpoint     |
| `USGS_MCP_URL`          | MCP Server 1 base URL (optional)       |
| `SCHEDULER_MCP_URL`     | MCP Server 2 base URL (optional)       |
| `SESSIONS_BUCKET_NAME`  | Agent sessions S3 bucket               |
| `REPORTS_BUCKET_NAME`   | Briefing reports S3 bucket             |
| `EVENT_QUEUE_URL`       | Main SQS event queue URL               |
| `DEAD_LETTER_QUEUE_URL` | Dead-letter queue URL                  |
| `AWS_REGION`            | Region for SigV4 signing / SDK clients |

```bash
DATA_API_URL=https://api.earthquake-agent.example.com \
WEBHOOK_URL=https://webhook.earthquake-agent.example.com \
REPORTS_BUCKET_NAME=earthquakeagent-reports-... \
DEAD_LETTER_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/123456789012/...-dlq \
AWS_REGION=us-east-1 \
npx vitest run packages/integration-tests
```

### Option B — CDK outputs file

Deploy the stack writing an outputs file, then point the suite at it:

```bash
npx cdk deploy --all --outputs-file cdk-outputs.json
CDK_OUTPUTS_FILE=$PWD/cdk-outputs.json npx vitest run packages/integration-tests
```

The loader maps the relevant `CfnOutput`s (see `packages/cdk/lib/*`) onto the
configuration, deriving the dead-letter queue URL from its exported ARN.

## AWS credentials

The suite signs Data API and MCP requests with SigV4 using the default AWS
credential provider chain, so the calling identity must be granted
`execute-api:Invoke` on the Data API (and have read access to the sessions /
reports buckets and the dead-letter queue). Run with credentials for the
account the stack is deployed to.
