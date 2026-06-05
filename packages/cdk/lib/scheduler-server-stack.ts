import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { McpServerConstruct } from "./mcp-server-construct.js";
import { resolveDomainName, type SharedProps } from "./shared-props.js";

export type SchedulerServerStackProps = cdk.StackProps & SharedProps;

/**
 * MCP Server 2 (Message Scheduler) stack for the MCP Events Serverless Agent
 * sample.
 *
 * The shared MCP server infrastructure (IAM-authorized REGIONAL API Gateway
 * custom domain `scheduler-mcp.<subdomain>.<parentDomain>`, the dual-trigger
 * Lambda, the Subscriptions DynamoDB table, and the per-subscription
 * webhook-secret KMS key) lives in {@link McpServerConstruct}; this stack
 * supplies the Scheduler differences and adds the scheduler-only extra route
 * (Requirements 2.x, 13.4, 13.5, 14.x, 17.6):
 * - The EventBridge rule fires every 1 minute to check which customers are due
 *   for a briefing (Requirements 2.1, 2.3).
 * - A manual `POST /trigger-briefing/{customerId}` route (the Data API calls it
 *   with SigV4) that only this server has.
 *
 * Cross-stack wiring follows the design's CfnOutput / Fn.importValue approach
 * (same pattern as DataApiStack) so this stack stays environment agnostic:
 * the construct imports the wildcard certificate ARN and subdomain hosted zone
 * from DnsRegionalStack.
 *
 * WEBHOOK SECRET NOTE (Requirements 14.3, 17.5): Per the MCP Events extension,
 * the Standard Webhooks signing secret is client-supplied per subscription. The
 * Subscription Manager generates a `whsec_` secret per subscription and passes
 * it in `delivery.secret` on `events/subscribe`; this server stores that secret
 * on the subscription's record in the Subscriptions table and signs that
 * subscription's webhook deliveries with it. The secret is client-side
 * encrypted with this stack's own customer-managed KMS key BEFORE being written
 * to the table (so DynamoDB only ever holds ciphertext) and decrypted in memory
 * with `kms:Decrypt` when signing a delivery. The server never generates a
 * secret, so there is no per-server SSM SecureString parameter. Each
 * Subscriptions table has its own key, owned by the service that owns the
 * table; this stack owns the Scheduler table's key.
 *
 * HANDLER NOTE: The Lambda handler lives in the @mcp-events/scheduler-server
 * package at src/handler.ts, which the construct points the NodejsFunction
 * `entry` at (this fixes the prior bug where the entry pointed at the
 * placeholder src/index.ts).
 */
export class SchedulerServerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SchedulerServerStackProps) {
    super(scope, id, props);

    const domainName = resolveDomainName(props);

    // --- Shared MCP server infrastructure ------------------------------------
    const mcpServer = new McpServerConstruct(this, "McpServer", {
      domainName,
      subdomainLabel: "scheduler-mcp",
      packageDirName: "scheduler-server",
      restApiName: "earthquake-agent-scheduler-mcp",
      apiDescription:
        "MCP Server 2 (Message Scheduler) HTTP transport for the MCP Events Serverless Agent sample",
      kmsKeyDescription:
        "Client-side encryption key for per-subscription webhook secrets in the Scheduler server Subscriptions table",
      kmsAlias: "alias/earthquake-agent/scheduler-subscription-secret",
      scheduleRate: cdk.Duration.minutes(15),
      scheduleDescription:
        "Triggers MCP Server 2 to check which customers are due for a briefing every 1 minute",
      exportPrefix: "SchedulerMcp",
      aliasRecordComment:
        "Alias to the MCP Server 2 custom domain (scheduler-mcp.earthquake-agent.*)",
    });

    // --- Scheduler-only route: manual briefing trigger -----------------------
    // The manual trigger is exposed at `/trigger-briefing/{customerId}` (the
    // Data API calls it with SigV4), IAM-authorized like every other route.
    const triggerBriefing = mcpServer.api.root.addResource("trigger-briefing");
    const triggerBriefingCustomer = triggerBriefing.addResource("{customerId}");
    triggerBriefingCustomer.addMethod(
      "POST",
      mcpServer.integration,
      mcpServer.iamAuth,
    );
  }
}
