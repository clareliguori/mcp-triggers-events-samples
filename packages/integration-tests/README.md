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
(for example in CI with no deployed stack). Configuration is resolved once from
three sources (env vars, a CDK outputs file, then the live CloudFormation stack
exports — see [Configuration](#configuration)); the live query is bounded and
never throws. Each flow declares the stack endpoints / resources it requires and
**skips gracefully** (`describe.skip`) when any are still missing, so:

```bash
npx vitest run packages/integration-tests
```

**always exits 0**: with no stack reachable the e2e flows are reported as
skipped (and the configuration unit tests still run and pass); with a stack
deployed and credentials available the same command runs the flows for real.

## Configuration

Provide the stack's endpoints and resource names from any of **three** sources,
checked in precedence order. A lower-precedence source only fills fields a
higher one left unset — it never overrides a value already provided:

1. **Individual environment variables** (highest precedence).
2. **A CDK outputs file** referenced by `CDK_OUTPUTS_FILE`.
3. **The live, deployed CloudFormation stack exports** (lowest precedence),
   queried automatically with the AWS SDK.

When the stack is deployed and AWS credentials are available, **no env vars and
no outputs file are needed**: the suite resolves every endpoint / resource name
from the live `EarthquakeAgent-*` CloudFormation exports and runs the flows
automatically.

### Option A — environment variables

| Variable                     | Purpose                                |
| ---------------------------- | -------------------------------------- |
| `DATA_API_URL`               | Data API base URL                      |
| `WEBHOOK_URL`                | Webhook Receiver delivery endpoint     |
| `USGS_MCP_URL`               | MCP Server 1 base URL (optional)       |
| `SCHEDULER_MCP_URL`          | MCP Server 2 base URL (optional)       |
| `SESSIONS_BUCKET_NAME`       | Agent sessions S3 bucket               |
| `REPORTS_BUCKET_NAME`        | Briefing reports S3 bucket             |
| `EVENT_QUEUE_URL`            | Main SQS event queue URL               |
| `DEAD_LETTER_QUEUE_URL`      | Dead-letter queue URL                  |
| `CUSTOMER_CONFIG_TABLE_NAME` | CustomerConfig DynamoDB table name     |
| `AWS_REGION`                 | Region for SigV4 signing / SDK clients |

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

### Option C — live CloudFormation exports (default for a deployed stack)

With the stack deployed and credentials available, just run the suite — no env
vars, no outputs file:

```bash
AWS_REGION=us-east-1 npx vitest run packages/integration-tests
```

The suite makes a single (paginated) `cloudformation:ListExports` call in the
configured region and maps the stable, globally-unique `EarthquakeAgent-*`
export names onto the configuration:

| Export name                                                              | Field                     |
| ------------------------------------------------------------------------ | ------------------------- |
| `EarthquakeAgent-DataApiCustomDomainUrl` (or `-DataApiUrl`)              | `dataApiUrl`              |
| `EarthquakeAgent-WebhookCustomDomainUrl`                                 | `webhookUrl`              |
| `EarthquakeAgent-UsgsMcpCustomDomainUrl` (or `-UsgsMcpApiUrl`)           | `usgsMcpUrl`              |
| `EarthquakeAgent-SchedulerMcpCustomDomainUrl` (or `-SchedulerMcpApiUrl`) | `schedulerMcpUrl`         |
| `EarthquakeAgent-SessionsBucketName`                                     | `sessionsBucketName`      |
| `EarthquakeAgent-ReportsBucketName`                                      | `reportsBucketName`       |
| `EarthquakeAgent-WebhookQueueUrl`                                        | `eventQueueUrl`           |
| `EarthquakeAgent-WebhookDeadLetterQueueArn` (URL derived from ARN)       | `deadLetterQueueUrl`      |
| `EarthquakeAgent-CustomerConfigTableName`                                | `customerConfigTableName` |

The live query is **bounded and failure-tolerant**: it only runs when a higher
source left a field unset, it has a short timeout (default 8s, override with
`INTEGRATION_CFN_TIMEOUT_MS`), and on any failure (no credentials, no stack,
access denied, network error, timeout) it contributes nothing — the dependent
flows simply skip and the suite still exits 0. Disable it entirely with
`INTEGRATION_DISABLE_CFN_LOOKUP=1` (or `=true`) to rely on env vars / the outputs
file only.

## AWS credentials

The suite authenticates as an IAM (SigV4) backend caller using the default AWS
credential provider chain, so the calling identity must be granted:

- `cloudformation:ListExports` — to resolve endpoints / resource names from the
  live stack exports (when not supplied via env vars or an outputs file),
- `execute-api:Invoke` on the Data API (IAM-authorized routes only — see below),
- `dynamodb:PutItem` and `dynamodb:DeleteItem` on the CustomerConfig table — to
  seed and tear down customer config (see [Config writes](#why-config-writes-go-through-dynamodb)),
- `s3:ListBucket` and `s3:GetObject` on the sessions and reports buckets — to
  read session conversation history and briefing reports, and
- `sqs:ReceiveMessage` on the dead-letter queue.

Run with credentials for the account the stack is deployed to.

### IAM vs Cognito: how the harness reaches each surface

The deployed Data API splits its routes between two authorizers, and the harness
is an IAM caller, so it routes each operation to whatever the live API actually
exposes to a SigV4 caller — and goes around the API where there is no IAM path:

| Operation             | How the harness does it                                                       | Why                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Read customer config  | `GET /backend/customers/{id}/config` (IAM)                                    | The webapp `GET /customers/{id}/config` route is Cognito-only                                                   |
| Subscriptions (R/W)   | `GET/POST /customers/{id}/subscriptions`, `GET/PUT /subscriptions/{id}` (IAM) | Already IAM-authorized                                                                                          |
| Write/delete config   | Direct DynamoDB `PutItem` / `DeleteItem` on the CustomerConfig table          | There is **no** IAM-authorized config write/delete route                                                        |
| Read session messages | Direct S3 `GetObject` of the session snapshot                                 | The `GET .../session/messages` route is Cognito-only                                                            |
| List/read reports     | Direct S3 `ListObjectsV2` + `GetObject` under the reports prefix              | The `GET .../reports` route is Cognito-only (report writes use the IAM `POST .../reports` route the agent uses) |

#### Why config writes go through DynamoDB

The Data API exposes customer config create/update/delete only on
Cognito-authorized routes (`PUT`/`DELETE /customers/{id}/config`); there is no
IAM-authorized equivalent, so a SigV4 (IAM) caller cannot create config through
the API. The harness therefore writes the `CustomerConfig` item **directly to
the CustomerConfig DynamoDB table** (resolved from the
`EarthquakeAgent-CustomerConfigTableName` export). This is not just a
convenience: a direct `PutItem` fires the table's DynamoDB Stream, which is
exactly the trigger the Subscription Manager consumes to create subscriptions on
both MCP servers — so seeding config this way both drives every flow that needs
a customer **and** exercises the real DynamoDB Stream -> Subscription Manager
registration path the registration flow asserts on.
