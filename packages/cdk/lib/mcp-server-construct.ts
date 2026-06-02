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

import { addApiGatewayAlarms, addLambdaAlarms } from "./alarms.js";

/**
 * Configuration for an {@link McpServerConstruct}.
 *
 * Every field captures a per-server difference between the two MCP servers
 * (USGS Earthquake Feed and Message Scheduler); the construct itself owns the
 * ~90% of infrastructure both servers share.
 */
export interface McpServerConstructProps {
  /** Resolved subdomain, e.g. "earthquake-agent.liguori.people.aws.dev". */
  domainName: string;
  /** Subdomain label for the MCP custom domain, e.g. "usgs-mcp" | "scheduler-mcp". */
  subdomainLabel: string;
  /** Workspace package directory under packages/, e.g. "usgs-server" | "scheduler-server". */
  packageDirName: string;
  /** REST API name, e.g. "earthquake-agent-usgs-mcp". */
  restApiName: string;
  /** REST API description. */
  apiDescription: string;
  /** KMS key description. */
  kmsKeyDescription: string;
  /** KMS alias name, e.g. "alias/earthquake-agent/usgs-subscription-secret". */
  kmsAlias: string;
  /** EventBridge schedule rate. */
  scheduleRate: cdk.Duration;
  /** EventBridge rule description. */
  scheduleDescription: string;
  /** Extra Lambda environment variables merged over the common set. */
  extraEnvironment?: Record<string, string>;
  /** Export-name prefix for CfnOutputs, e.g. "UsgsMcp" | "SchedulerMcp". */
  exportPrefix: string;
  /** Route53 alias record comment. */
  aliasRecordComment: string;
}

/**
 * Shared infrastructure for an MCP server in the MCP Events Serverless Agent
 * sample.
 *
 * The two MCP servers (MCP Server 1 - USGS Earthquake Feed and MCP Server 2 -
 * Message Scheduler) are ~90% identical: each exposes an IAM-authorized
 * REGIONAL API Gateway custom domain (`<subdomainLabel>.<domainName>`) for the
 * MCP HTTP transport, a dual-trigger Lambda (API Gateway plus an EventBridge
 * poll/check schedule), a Subscriptions DynamoDB table, and a dedicated KMS key
 * for the per-subscription webhook secret. This construct owns that common
 * surface so each stack reduces to just its differences (its extra tables,
 * environment variables, and routes).
 *
 * Responsibilities (Requirements 1.x, 2.x, 13.4, 13.5, 14.x, 17.6):
 * - API Gateway REST API at the custom domain `<subdomainLabel>.<domainName>`.
 *   The MCP HTTP transport is server-to-server only (the Subscription Manager
 *   connects with SigV4), so every route uses IAM authorization
 *   (Requirement 17.6).
 * - A single Lambda handler with dual triggers: API Gateway (MCP protocol) and
 *   an EventBridge rule that fires on the configured rate.
 * - DynamoDB Subscriptions table (per-customer webhook subscriptions managed by
 *   the MCP server) with a TTL attribute so DynamoDB expires stale rows.
 *
 * Cross-stack wiring follows the design's CfnOutput / Fn.importValue approach
 * (same pattern as DataApiStack) so the owning stack stays environment
 * agnostic: imports the wildcard certificate ARN and subdomain hosted zone from
 * DnsRegionalStack.
 *
 * WEBHOOK SECRET NOTE (Requirements 14.3, 17.5): Per the MCP Events extension,
 * the Standard Webhooks signing secret is client-supplied per subscription. The
 * Subscription Manager generates a `whsec_` secret per subscription and passes
 * it in `delivery.secret` on `events/subscribe`; the MCP server stores that
 * secret on the subscription's record in the Subscriptions table and signs that
 * subscription's webhook deliveries with it. The secret is client-side
 * encrypted with this construct's own customer-managed KMS key BEFORE being
 * written to the table (so DynamoDB only ever holds ciphertext) and decrypted in
 * memory with `kms:Decrypt` when signing a delivery. The server never generates
 * a secret, so there is no per-server SSM SecureString parameter. Each
 * Subscriptions table has its own key, owned by the service that owns the
 * table.
 *
 * The Lambda handler always points at the owning package's `src/handler.ts`.
 *
 * Public members ({@link handler}, {@link api}, {@link integration},
 * {@link iamAuth}) let the owning stack add server-specific tables, environment
 * variables, and routes on top of the shared surface.
 */
export class McpServerConstruct extends Construct {
  /** The dual-trigger MCP Lambda handler. */
  public readonly handler: NodejsFunction;
  /** The IAM-authorized REGIONAL REST API for the MCP HTTP transport. */
  public readonly api: apigateway.RestApi;
  /** Lambda proxy integration shared by every route. */
  public readonly integration: apigateway.LambdaIntegration;
  /** IAM authorization option applied to every route (Requirement 17.6). */
  public readonly iamAuth: apigateway.MethodOptions;

  constructor(scope: Construct, id: string, props: McpServerConstructProps) {
    super(scope, id);

    const mcpDomainName = `${props.subdomainLabel}.${props.domainName}`;
    // The Webhook Receiver lives at a deterministic custom domain created by
    // WebhookReceiverStack. Each MCP server delivers events there; pass the URL
    // as an environment variable rather than a cross-stack import to avoid a
    // synth-time ordering dependency.
    const webhookUrl = `https://webhook.${props.domainName}`;

    // --- DynamoDB: Subscriptions ---------------------------------------------
    // subscriptionId is the partition key. The MCP server manages the lifecycle
    // (create on events/subscribe, refresh, expire) and scans active
    // subscriptions to fan out matching events. A TTL attribute lets DynamoDB
    // expire stale subscriptions automatically.
    const subscriptionsTable = new dynamodb.Table(this, "SubscriptionsTable", {
      partitionKey: {
        name: "subscriptionId",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: "ttl",
      // Demo sample: tear the table down cleanly with the stack.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- KMS: per-table key for client-side secret encryption ----------------
    // The MCP server client-side encrypts each subscription's client-supplied
    // `whsec_` secret with this customer-managed key before writing it to the
    // Subscriptions table, and decrypts it in memory to sign deliveries
    // (Requirement 17.5). The key is owned by this construct (it owns the table).
    const subscriptionSecretKey = new kms.Key(this, "SubscriptionSecretKey", {
      description: props.kmsKeyDescription,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    subscriptionSecretKey.addAlias(props.kmsAlias);

    // --- Lambda handler -------------------------------------------------------
    // Compiled construct lives at packages/cdk/dist/lib, so walk up to the
    // repo's packages/ directory to reach the server source and up to the repo
    // root for the workspace lock file (same pattern as DataApiStack). The
    // handler always lives at the owning package's src/handler.ts.
    const handler = new NodejsFunction(this, "Handler", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(
        __dirname,
        "..",
        "..",
        "..",
        props.packageDirName,
        "src",
        "handler.ts",
      ),
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
        SUBSCRIPTIONS_TABLE_NAME: subscriptionsTable.tableName,
        SUBSCRIPTION_SECRET_KEY_ID: subscriptionSecretKey.keyArn,
        WEBHOOK_URL: webhookUrl,
        ...(props.extraEnvironment ?? {}),
      },
    });
    this.handler = handler;

    // --- IAM grants (least privilege) ----------------------------------------
    subscriptionsTable.grantReadWriteData(handler);
    // Encrypt on subscribe, decrypt to sign deliveries.
    subscriptionSecretKey.grantEncryptDecrypt(handler);

    // --- EventBridge: poll/check on the configured rate ----------------------
    new events.Rule(this, "Schedule", {
      schedule: events.Schedule.rate(props.scheduleRate),
      description: props.scheduleDescription,
      targets: [new targets.LambdaFunction(handler)],
    });

    // --- API Gateway custom domain + REST API (IAM auth) ---------------------
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      "WildcardCertificate",
      cdk.Fn.importValue("EarthquakeAgent-RegionalWildcardCertificateArn"),
    );

    const api = new apigateway.RestApi(this, "McpApi", {
      restApiName: props.restApiName,
      description: props.apiDescription,
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
    this.api = api;

    const integration = new apigateway.LambdaIntegration(handler);
    this.integration = integration;

    // Server-to-server transport: every route uses IAM authorization so only
    // SigV4-signing callers (the Subscription Manager) can reach the MCP
    // endpoints (Requirement 17.6).
    const iamAuth: apigateway.MethodOptions = {
      authorizationType: apigateway.AuthorizationType.IAM,
    };
    this.iamAuth = iamAuth;

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
        zoneName: props.domainName,
      },
    );

    new route53.ARecord(this, "McpAliasRecord", {
      zone: subdomainZone,
      recordName: mcpDomainName,
      target: route53.RecordTarget.fromAlias(
        new route53targets.ApiGatewayDomain(api.domainName!),
      ),
      comment: props.aliasRecordComment,
    });

    // --- Cross-stack exports --------------------------------------------------
    new cdk.CfnOutput(this, `${props.exportPrefix}ApiUrl`, {
      value: api.url,
      description: `Invoke URL of the ${props.exportPrefix} API`,
      exportName: `EarthquakeAgent-${props.exportPrefix}ApiUrl`,
    });

    new cdk.CfnOutput(this, `${props.exportPrefix}CustomDomainUrl`, {
      value: `https://${mcpDomainName}`,
      description: `Custom domain URL of the ${props.exportPrefix} API`,
      exportName: `EarthquakeAgent-${props.exportPrefix}CustomDomainUrl`,
    });

    // --- Monitoring alarms ---------------------------------------------------
    const alarmId = props.exportPrefix.toLowerCase();
    addLambdaAlarms(this, alarmId, handler);
    addApiGatewayAlarms(this, alarmId, api);
  }
}
