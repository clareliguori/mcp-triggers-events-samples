import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import { McpServerConstruct } from "./mcp-server-construct.js";
import { resolveDomainName, type SharedProps } from "./shared-props.js";

export type UsgsServerStackProps = cdk.StackProps & SharedProps;

/**
 * MCP Server 1 (USGS Earthquake Feed) stack for the MCP Events Serverless
 * Agent sample.
 *
 * The shared MCP server infrastructure (IAM-authorized REGIONAL API Gateway
 * custom domain `usgs-mcp.<subdomain>.<parentDomain>`, the dual-trigger Lambda,
 * the Subscriptions DynamoDB table, and the per-subscription webhook-secret KMS
 * key) lives in {@link McpServerConstruct}; this stack supplies the USGS
 * differences and adds the USGS-only extras (Requirements 1.x, 13.4, 13.5,
 * 14.x, 17.6):
 * - The EventBridge rule fires every 5 minutes to poll the USGS feed
 *   (Requirement 1.1).
 * - A Cursor State DynamoDB table (shared, single-row cursor for feed
 *   deduplication) that only this server has.
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
 * table; this stack owns the USGS table's key.
 *
 * HANDLER NOTE: The Lambda handler lives in the @mcp-events/usgs-server package
 * at src/handler.ts, which the construct points the NodejsFunction `entry` at.
 */
export class UsgsServerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: UsgsServerStackProps) {
    super(scope, id, props);

    const domainName = resolveDomainName(props);

    // --- Shared MCP server infrastructure ------------------------------------
    const mcpServer = new McpServerConstruct(this, "McpServer", {
      domainName,
      subdomainLabel: "usgs-mcp",
      packageDirName: "usgs-server",
      restApiName: "earthquake-agent-usgs-mcp",
      apiDescription:
        "MCP Server 1 (USGS Earthquake Feed) HTTP transport for the MCP Events Serverless Agent sample",
      kmsKeyDescription:
        "Client-side encryption key for per-subscription webhook secrets in the USGS server Subscriptions table",
      kmsAlias: "alias/earthquake-agent/usgs-subscription-secret",
      scheduleRate: cdk.Duration.minutes(5),
      scheduleDescription:
        "Triggers MCP Server 1 to poll the USGS earthquake feed every 5 minutes",
      exportPrefix: "UsgsMcp",
      aliasRecordComment:
        "Alias to the MCP Server 1 custom domain (usgs-mcp.earthquake-agent.*)",
      extraEnvironment: {
        USGS_FEED_URL:
          "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson",
      },
    });

    // --- DynamoDB: USGS Cursor State (USGS-only) -----------------------------
    // Single shared cursor row (cursorId is a fixed value, e.g. "usgs-2.5-day")
    // tracking which earthquake IDs have already been emitted so polling is
    // deduplicated across runs (Requirements 1.1, 1.4, 1.6).
    const cursorStateTable = new dynamodb.Table(this, "CursorStateTable", {
      partitionKey: { name: "cursorId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Demo sample: tear the table down cleanly with the stack.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    cursorStateTable.grantReadWriteData(mcpServer.handler);
    mcpServer.handler.addEnvironment(
      "CURSOR_STATE_TABLE_NAME",
      cursorStateTable.tableName,
    );
  }
}
