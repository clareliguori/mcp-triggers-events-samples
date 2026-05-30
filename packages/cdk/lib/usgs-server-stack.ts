import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as kms from "aws-cdk-lib/aws-kms";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53targets from "aws-cdk-lib/aws-route53-targets";
import { Construct } from "constructs";
import { resolveDomainName, type SharedProps } from "./shared-props.js";

export type UsgsServerStackProps = cdk.StackProps & SharedProps;

/**
 * MCP Server 1 (USGS Earthquake Feed) stack for the MCP Events Serverless
 * Agent sample.
 *
 * Responsibilities (Requirements 1.x, 13.4, 13.5, 14.x, 17.6):
 * - API Gateway REST API at the custom domain
 *   `usgs-mcp.<subdomain>.<parentDomain>` (for example
 *   `usgs-mcp.earthquake-agent.liguori.people.aws.dev`). The MCP HTTP transport
 *   is server-to-server only (the Subscription Manager connects with SigV4), so
 *   every route uses IAM authorization (Requirement 17.6).
 * - A single Lambda handler with dual triggers: API Gateway (MCP protocol) and
 *   an EventBridge rule that fires every 5 minutes to poll the USGS feed
 *   (Requirement 1.1).
 * - DynamoDB tables: Cursor State (shared, single-row cursor for feed
 *   deduplication) and Subscriptions (per-customer webhook subscriptions
 *   managed by the MCP server).
 *
 * Cross-stack wiring follows the design's CfnOutput / Fn.importValue approach
 * (same pattern as DataApiStack) so this stack stays environment agnostic:
 * imports the wildcard certificate ARN and subdomain hosted zone from DnsStack.
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
 * (subtask 6.5 creates src/handler.ts). It is not implemented yet, so the
 * NodejsFunction entry points at the existing placeholder src/index.ts so this
 * stack synthesizes today. Subtask 6.5 should repoint `entry` to src/handler.ts.
 */
export class UsgsServerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: UsgsServerStackProps) {
    super(scope, id, props);

    const domainName = resolveDomainName(props);
    const mcpDomainName = `usgs-mcp.${domainName}`;
    // The Webhook Receiver lives at a deterministic custom domain created by
    // WebhookReceiverStack (subtask 2.5). MCP Server 1 delivers earthquake
    // events there; pass the URL as an environment variable rather than a
    // cross-stack import to avoid a synth-time ordering dependency.
    const webhookUrl = `https://webhook.${domainName}`;

    // --- DynamoDB: USGS Cursor State -----------------------------------------
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

    // --- DynamoDB: Subscriptions ---------------------------------------------
    // subscriptionId is the partition key. MCP Server 1 manages the lifecycle
    // (create on events/subscribe, refresh, expire) and scans active
    // subscriptions to fan out matching earthquakes (Requirement 1.2). A TTL
    // attribute lets DynamoDB expire stale subscriptions automatically.
    const subscriptionsTable = new dynamodb.Table(this, "SubscriptionsTable", {
      partitionKey: {
        name: "subscriptionId",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- KMS: per-table key for client-side secret encryption ----------------
    // MCP Server 1 client-side encrypts each subscription's client-supplied
    // `whsec_` secret with this customer-managed key before writing it to the
    // Subscriptions table, and decrypts it in memory to sign deliveries
    // (Requirement 17.5). The key is owned by this stack (it owns the table).
    const subscriptionSecretKey = new kms.Key(this, "SubscriptionSecretKey", {
      description:
        "Client-side encryption key for per-subscription webhook secrets in the USGS server Subscriptions table",
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    subscriptionSecretKey.addAlias(
      "alias/earthquake-agent/usgs-subscription-secret",
    );

    // --- Lambda handler -------------------------------------------------------
    // Compiled stack lives at packages/cdk/dist/lib, so walk up to the repo's
    // packages/ directory to reach the usgs-server source and up to the repo
    // root for the workspace lock file (same pattern as DataApiStack).
    const usgsServerPackageRoot = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "usgs-server",
    );
    const handlerFn = new NodejsFunction(this, "UsgsServerHandler", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(usgsServerPackageRoot, "src", "index.ts"),
      handler: "handler",
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
      depsLockFilePath: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "package-lock.json",
      ),
      environment: {
        CURSOR_STATE_TABLE_NAME: cursorStateTable.tableName,
        SUBSCRIPTIONS_TABLE_NAME: subscriptionsTable.tableName,
        SUBSCRIPTION_SECRET_KEY_ID: subscriptionSecretKey.keyArn,
        WEBHOOK_URL: webhookUrl,
        USGS_FEED_URL:
          "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson",
      },
    });

    // --- IAM grants (least privilege) ----------------------------------------
    cursorStateTable.grantReadWriteData(handlerFn);
    subscriptionsTable.grantReadWriteData(handlerFn);
    // Encrypt on subscribe, decrypt to sign deliveries.
    subscriptionSecretKey.grantEncryptDecrypt(handlerFn);

    // --- EventBridge: poll the USGS feed every 5 minutes ---------------------
    new events.Rule(this, "PollSchedule", {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      description:
        "Triggers MCP Server 1 to poll the USGS earthquake feed every 5 minutes",
      targets: [new targets.LambdaFunction(handlerFn)],
    });

    // --- API Gateway custom domain + REST API (IAM auth) ---------------------
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      "WildcardCertificate",
      cdk.Fn.importValue("EarthquakeAgent-RegionalWildcardCertificateArn"),
    );

    const api = new apigateway.RestApi(this, "UsgsMcpApi", {
      restApiName: "earthquake-agent-usgs-mcp",
      description:
        "MCP Server 1 (USGS Earthquake Feed) HTTP transport for the MCP Events Serverless Agent sample",
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      domainName: {
        domainName: mcpDomainName,
        certificate,
        endpointType: apigateway.EndpointType.REGIONAL,
        securityPolicy: apigateway.SecurityPolicy.TLS_1_2,
      },
      deployOptions: {
        stageName: "prod",
      },
    });

    const integration = new apigateway.LambdaIntegration(handlerFn);

    // Server-to-server transport: every route uses IAM authorization so only
    // SigV4-signing callers (the Subscription Manager) can reach the MCP
    // endpoints (Requirement 17.6).
    const iamAuth: apigateway.MethodOptions = {
      authorizationType: apigateway.AuthorizationType.IAM,
    };

    // The MCP Streamable HTTP transport posts JSON-RPC messages to a single
    // endpoint. Expose `/mcp` (POST) plus a greedy `{proxy+}` ANY fallback so
    // the handler can serve the full MCP surface, all IAM-authorized.
    const mcp = api.root.addResource("mcp");
    mcp.addMethod("POST", integration, iamAuth);

    const proxy = api.root.addResource("{proxy+}");
    proxy.addMethod("ANY", integration, iamAuth);

    // --- Route53 alias to the API custom domain ------------------------------
    const subdomainZone = route53.HostedZone.fromHostedZoneAttributes(
      this,
      "SubdomainZone",
      {
        hostedZoneId: cdk.Fn.importValue("EarthquakeAgent-SubdomainZoneId"),
        zoneName: domainName,
      },
    );

    new route53.ARecord(this, "UsgsMcpAliasRecord", {
      zone: subdomainZone,
      recordName: mcpDomainName,
      target: route53.RecordTarget.fromAlias(
        new route53targets.ApiGatewayDomain(api.domainName!),
      ),
      comment:
        "Alias to the MCP Server 1 custom domain (usgs-mcp.earthquake-agent.*)",
    });

    // --- Cross-stack exports --------------------------------------------------
    new cdk.CfnOutput(this, "UsgsMcpApiUrl", {
      value: api.url,
      description: "Invoke URL of the MCP Server 1 (USGS) API",
      exportName: "EarthquakeAgent-UsgsMcpApiUrl",
    });

    new cdk.CfnOutput(this, "UsgsMcpCustomDomainUrl", {
      value: `https://${mcpDomainName}`,
      description: "Custom domain URL of the MCP Server 1 (USGS) API",
      exportName: "EarthquakeAgent-UsgsMcpCustomDomainUrl",
    });
  }
}
