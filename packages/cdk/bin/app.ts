#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AgentStack } from "../lib/agent-stack.js";
import { AuthStack } from "../lib/auth-stack.js";
import { DataApiStack } from "../lib/data-api-stack.js";
import { DnsStack } from "../lib/dns-stack.js";
import { SchedulerServerStack } from "../lib/scheduler-server-stack.js";
import { SubscriptionManagerStack } from "../lib/subscription-manager-stack.js";
import { UsgsServerStack } from "../lib/usgs-server-stack.js";
import { WebappStack } from "../lib/webapp-stack.js";
import { WebhookReceiverStack } from "../lib/webhook-receiver-stack.js";
import {
  DEFAULT_PARENT_DOMAIN,
  DEFAULT_SUBDOMAIN,
  type SharedProps,
} from "../lib/shared-props.js";

const app = new cdk.App();

// Shared configuration for every stack. `parentDomain` can be overridden at
// synth/deploy time with `-c parentDomain=example.com`.
const shared: SharedProps = {
  parentDomain:
    (app.node.tryGetContext("parentDomain") as string | undefined) ??
    DEFAULT_PARENT_DOMAIN,
  subdomain:
    (app.node.tryGetContext("subdomain") as string | undefined) ??
    DEFAULT_SUBDOMAIN,
};

// DnsStack uses Route53 HostedZone.fromLookup, which requires a concrete
// account and region at synth time. Resolve them from the standard CDK
// environment variables populated by the CLI.
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

new DnsStack(app, "DnsStack", { ...shared, env });

// AuthStack (Cognito User Pool + custom Hosted UI domain) imports the shared
// wildcard certificate and subdomain zone from DnsStack via Fn.importValue, so
// it is given the same env to keep those cross-stack exports in the same
// account and region. The custom Hosted UI domain also requires the shared
// certificate to live in us-east-1, so deploy this sample to us-east-1.
new AuthStack(app, "AuthStack", { ...shared, env });

// DataApiStack (API Gateway + Lambda for config, subscriptions, reports, and
// the read-only session messages endpoint) imports the shared wildcard
// certificate and subdomain zone from DnsStack, the Cognito User Pool id from
// AuthStack, and the sessions bucket ARN from AgentStack, all via
// Fn.importValue. It is given the same env so those cross-stack exports stay in
// the same account and region. AgentStack (subtask 2.5) MUST export its
// sessions bucket ARN under the export name `EarthquakeAgent-SessionsBucketArn`
// for the read-only s3:GetObject grant to resolve at deploy time.
new DataApiStack(app, "DataApiStack", { ...shared, env });

// UsgsServerStack (MCP Server 1 - USGS Earthquake Feed) and SchedulerServerStack
// (MCP Server 2 - Message Scheduler) each expose an IAM-authorized API Gateway
// custom domain (usgs-mcp/scheduler-mcp.earthquake-agent.<parentDomain>) for the
// MCP HTTP transport, a dual-trigger Lambda (API Gateway + an EventBridge poll
// schedule), DynamoDB tables, and an SSM SecureString for the webhook HMAC
// secret. They import the shared wildcard certificate and subdomain zone from
// DnsStack via Fn.importValue, so they are given the same env to keep those
// cross-stack exports in the same account and region.
new UsgsServerStack(app, "UsgsServerStack", { ...shared, env });
new SchedulerServerStack(app, "SchedulerServerStack", { ...shared, env });

// WebhookReceiverStack (open API Gateway custom domain
// webhook.earthquake-agent.<parentDomain> + SQS event queue, DLQ, and a
// CloudWatch alarm on DLQ depth) owns the webhook delivery endpoint both MCP
// servers target. It imports the shared wildcard certificate and subdomain
// zone from DnsStack, and references the per-server HMAC SSM secret names so
// the handler can validate Standard Webhooks signatures. It exports the SQS
// queue ARN consumed by AgentStack.
new WebhookReceiverStack(app, "WebhookReceiverStack", { ...shared, env });

// AgentStack (Serverless Strands Agent Lambda triggered by the Webhook
// Receiver SQS queue with batch size 1, an S3 sessions bucket, and a DynamoDB
// session locks table) imports the webhook queue ARN from WebhookReceiverStack
// and exports its sessions bucket ARN under EarthquakeAgent-SessionsBucketArn,
// which DataApiStack imports for read-only session access.
new AgentStack(app, "AgentStack", { ...shared, env });

// SubscriptionManagerStack (Lambda with dual triggers: the CustomerConfig
// DynamoDB Stream from DataApiStack plus an EventBridge refresh schedule)
// imports the CustomerConfig stream ARN from DataApiStack and holds an
// execute-api:Invoke role for the MCP server API Gateways and the Data API.
new SubscriptionManagerStack(app, "SubscriptionManagerStack", {
  ...shared,
  env,
});

// WebappStack (S3 SPA bucket fronted by a CloudFront distribution at
// app.earthquake-agent.<parentDomain> using Origin Access Control, with a
// security response headers policy) imports the shared wildcard certificate and
// subdomain zone from DnsStack.
new WebappStack(app, "WebappStack", { ...shared, env });

app.synth();
