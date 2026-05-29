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

export type SchedulerServerStackProps = cdk.StackProps & SharedProps;

/** SSM parameter name that holds MCP Server 2's webhook HMAC secret. */
export const SCHEDULER_HMAC_SECRET_PARAMETER_NAME =
  "/earthquake-agent/scheduler-server/hmac-secret";

/**
 * MCP Server 2 (Message Scheduler) stack for the MCP Events Serverless Agent
 * sample.
 *
 * Responsibilities (Requirements 2.x, 13.4, 13.5, 14.x, 17.5, 17.6):
 * - API Gateway REST API at the custom domain
 *   `scheduler-mcp.<subdomain>.<parentDomain>` (for example
 *   `scheduler-mcp.earthquake-agent.liguori.people.aws.dev`). The MCP HTTP
 *   transport is server-to-server only (the Subscription Manager connects with
 *   SigV4, and the Data API calls the manual-trigger route with SigV4), so
 *   every route uses IAM authorization (Requirement 17.6).
 * - A single Lambda handler with dual triggers: API Gateway (MCP protocol plus
 *   the manual `POST /trigger-briefing/:customerId` route) and an EventBridge
 *   rule that fires every 1 minute to check which customers are due for a
 *   briefing (Requirements 2.1, 2.3).
 * - DynamoDB table: Subscriptions (per-customer webhook subscriptions, each
 *   carrying that customer's cron schedule).
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
 * ({@link SCHEDULER_HMAC_SECRET_PARAMETER_NAME}) and exported so the deploy step
 * and the Webhook Receiver can resolve it. This keeps the secret encrypted at
 * rest in SSM as the requirement demands while remaining synthesizable.
 *
 * HANDLER NOTE: The Lambda handler lives in the @mcp-events/scheduler-server
 * package (subtask 7.3 creates src/handler.ts). It is not implemented yet, so
 * the NodejsFunction entry points at the existing placeholder src/index.ts so
 * this stack synthesizes today. Subtask 7.3 should repoint `entry` to
 * src/handler.ts.
 */
export class SchedulerServerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SchedulerServerStackProps) {
    super(scope, id, props);

    const domainName = resolveDomainName(props);
    const mcpDomainName = `scheduler-mcp.${domainName}`;
    // The Webhook Receiver lives at a deterministic custom domain created by
    // WebhookReceiverStack (subtask 2.5). MCP Server 2 delivers briefing
    // triggers there; pass the URL as an environment variable rather than a
    // cross-stack import to avoid a synth-time ordering dependency.
    const webhookUrl = `https://webhook.${domainName}`;

    // --- DynamoDB: Subscriptions ---------------------------------------------
    // subscriptionId is the partition key. Each subscription carries the
    // customer's cron schedule; MCP Server 2 scans active subscriptions every
    // minute and fires briefing.trigger events for customers whose schedule is
    // due (Requirements 2.1, 2.3). A TTL attribute lets DynamoDB expire stale
    // subscriptions automatically.
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

    // --- SSM SecureString: Standard Webhooks HMAC secret ---------------------
    // Referenced by name (see HMAC SECRET NOTE above); the value is populated
    // out of band. The Lambda reads it at runtime to sign webhook deliveries.
    const hmacSecretParameter =
      ssm.StringParameter.fromSecureStringParameterAttributes(
        this,
        "HmacSecretParameter",
        { parameterName: SCHEDULER_HMAC_SECRET_PARAMETER_NAME },
      );

    // --- Lambda handler -------------------------------------------------------
    // Compiled stack lives at packages/cdk/dist/lib, so walk up to the repo's
    // packages/ directory to reach the scheduler-server source and up to the
    // repo root for the workspace lock file (same pattern as DataApiStack).
    const schedulerServerPackageRoot = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "scheduler-server",
    );
    const handlerFn = new NodejsFunction(this, "SchedulerServerHandler", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(schedulerServerPackageRoot, "src", "index.ts"),
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
        HMAC_SECRET_PARAMETER_NAME: SCHEDULER_HMAC_SECRET_PARAMETER_NAME,
        WEBHOOK_URL: webhookUrl,
      },
    });

    // --- IAM grants (least privilege) ----------------------------------------
    subscriptionsTable.grantReadWriteData(handlerFn);
    hmacSecretParameter.grantRead(handlerFn);

    // --- EventBridge: check schedules every 1 minute -------------------------
    new events.Rule(this, "ScheduleCheck", {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      description:
        "Triggers MCP Server 2 to check which customers are due for a briefing every 1 minute",
      targets: [new targets.LambdaFunction(handlerFn)],
    });

    // --- API Gateway custom domain + REST API (IAM auth) ---------------------
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      "WildcardCertificate",
      cdk.Fn.importValue("EarthquakeAgent-WildcardCertificateArn"),
    );

    const api = new apigateway.RestApi(this, "SchedulerMcpApi", {
      restApiName: "earthquake-agent-scheduler-mcp",
      description:
        "MCP Server 2 (Message Scheduler) HTTP transport for the MCP Events Serverless Agent sample",
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
    // SigV4-signing callers (the Subscription Manager and the Data API's
    // manual-trigger route) can reach the endpoints (Requirement 17.6).
    const iamAuth: apigateway.MethodOptions = {
      authorizationType: apigateway.AuthorizationType.IAM,
    };

    // The MCP Streamable HTTP transport posts JSON-RPC messages to `/mcp`. The
    // manual trigger is exposed at `/trigger-briefing/{customerId}`. A greedy
    // `{proxy+}` ANY fallback covers the remaining MCP surface, all
    // IAM-authorized.
    const mcp = api.root.addResource("mcp");
    mcp.addMethod("POST", integration, iamAuth);

    const triggerBriefing = api.root.addResource("trigger-briefing");
    const triggerBriefingCustomer = triggerBriefing.addResource("{customerId}");
    triggerBriefingCustomer.addMethod("POST", integration, iamAuth);

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

    new route53.ARecord(this, "SchedulerMcpAliasRecord", {
      zone: subdomainZone,
      recordName: mcpDomainName,
      target: route53.RecordTarget.fromAlias(
        new route53targets.ApiGatewayDomain(api.domainName!),
      ),
      comment:
        "Alias to the MCP Server 2 custom domain (scheduler-mcp.earthquake-agent.*)",
    });

    // --- Cross-stack exports --------------------------------------------------
    new cdk.CfnOutput(this, "SchedulerMcpApiUrl", {
      value: api.url,
      description: "Invoke URL of the MCP Server 2 (Scheduler) API",
      exportName: "EarthquakeAgent-SchedulerMcpApiUrl",
    });

    new cdk.CfnOutput(this, "SchedulerMcpCustomDomainUrl", {
      value: `https://${mcpDomainName}`,
      description: "Custom domain URL of the MCP Server 2 (Scheduler) API",
      exportName: "EarthquakeAgent-SchedulerMcpCustomDomainUrl",
    });

    new cdk.CfnOutput(this, "SchedulerHmacSecretParameterName", {
      value: SCHEDULER_HMAC_SECRET_PARAMETER_NAME,
      description:
        "SSM SecureString parameter name holding MCP Server 2's webhook HMAC secret (populate out of band)",
      exportName: "EarthquakeAgent-SchedulerHmacSecretParameterName",
    });
  }
}
