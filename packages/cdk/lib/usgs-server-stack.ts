import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53targets from "aws-cdk-lib/aws-route53-targets";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { resolveDomainName, type SharedProps } from "./shared-props.js";

export type UsgsServerStackProps = cdk.StackProps & SharedProps;

/** SSM parameter name that holds MCP Server 1's webhook HMAC secret. */
export const USGS_HMAC_SECRET_PARAMETER_NAME =
  "/earthquake-agent/usgs-server/hmac-secret";

/**
 * MCP Server 1 (USGS Earthquake Feed) stack for the MCP Events Serverless
 * Agent sample.
 *
 * Responsibilities (Requirements 1.x, 13.4, 13.5, 14.x, 17.5, 17.6):
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
 * - An SSM SecureString that stores the Standard Webhooks HMAC secret used to
 *   sign webhook deliveries (Requirement 17.5).
 *
 * Cross-stack wiring follows the design's CfnOutput / Fn.importValue approach
 * (same pattern as DataApiStack) so this stack stays environment agnostic:
 * imports the wildcard certificate ARN and subdomain hosted zone from DnsStack.
 *
 * HMAC SECRET NOTE (Requirement 17.5): CloudFormation cannot create an SSM
 * parameter of type SecureString with a value (the CDK L2 `StringParameter`
 * rejects `SECURE_STRING` for new values, and `CfnParameter`/`AWS::SSM::Parameter`
 * does not support `SecureString` either). The documented, compliant pattern is
 * therefore to reference an existing SecureString by name with
 * `ssm.StringParameter.fromSecureStringParameterAttributes`, grant the Lambda
 * read access, and populate the secret value out of band (a one-time
 * `aws ssm put-parameter --type SecureString --name <name>` during deployment
 * setup, or a rotation job). The parameter name is deterministic
 * ({@link USGS_HMAC_SECRET_PARAMETER_NAME}) and exported so the deploy step and
 * the Webhook Receiver can resolve it. This keeps the secret encrypted at rest
 * in SSM as the requirement demands while remaining synthesizable.
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

    // --- SSM SecureString: Standard Webhooks HMAC secret ---------------------
    // Referenced by name (see HMAC SECRET NOTE above); the value is populated
    // out of band. The Lambda reads it at runtime to sign webhook deliveries.
    const hmacSecretParameter =
      ssm.StringParameter.fromSecureStringParameterAttributes(
        this,
        "HmacSecretParameter",
        { parameterName: USGS_HMAC_SECRET_PARAMETER_NAME },
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
        HMAC_SECRET_PARAMETER_NAME: USGS_HMAC_SECRET_PARAMETER_NAME,
        WEBHOOK_URL: webhookUrl,
        USGS_FEED_URL:
          "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson",
      },
    });

    // --- IAM grants (least privilege) ----------------------------------------
    cursorStateTable.grantReadWriteData(handlerFn);
    subscriptionsTable.grantReadWriteData(handlerFn);
    hmacSecretParameter.grantRead(handlerFn);

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

    new cdk.CfnOutput(this, "UsgsHmacSecretParameterName", {
      value: USGS_HMAC_SECRET_PARAMETER_NAME,
      description:
        "SSM SecureString parameter name holding MCP Server 1's webhook HMAC secret (populate out of band)",
      exportName: "EarthquakeAgent-UsgsHmacSecretParameterName",
    });
  }
}
