import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53targets from "aws-cdk-lib/aws-route53-targets";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { SCHEDULER_HMAC_SECRET_PARAMETER_NAME } from "./scheduler-server-stack.js";
import { resolveDomainName, type SharedProps } from "./shared-props.js";
import { USGS_HMAC_SECRET_PARAMETER_NAME } from "./usgs-server-stack.js";

export type WebhookReceiverStackProps = cdk.StackProps & SharedProps;

/**
 * Webhook Receiver stack for the MCP Events Serverless Agent sample.
 *
 * Responsibilities (Requirements 3.x, 13.4, 13.5, 17.1, 18.2, 19.2, 19.5):
 * - API Gateway REST API at the custom domain
 *   `webhook.<subdomain>.<parentDomain>` (for example
 *   `webhook.earthquake-agent.liguori.people.aws.dev`). Both MCP servers
 *   already hardcode this URL as their delivery target, so this stack only
 *   needs to own the domain.
 * - A Lambda proxy that validates the incoming Standard Webhooks HMAC-SHA256
 *   signature and enqueues the event to SQS with the `X-MCP-Subscription-Id`
 *   value as a message attribute (Requirements 3.1, 3.4).
 * - A standard (not FIFO) SQS queue with a redrive policy to a dead-letter
 *   queue, so events for different customers can be processed concurrently by
 *   the agent (Requirement 19.5) and failed events land in the DLQ after the
 *   retry budget is exhausted (Requirement 15.2).
 * - A CloudWatch alarm on the DLQ depth so operators are notified when messages
 *   accumulate (Requirement 18.2).
 *
 * AUTHORIZATION NOTE: The webhook endpoint is intentionally open (no IAM or
 * Cognito authorizer). MCP servers authenticate each delivery with a Standard
 * Webhooks HMAC-SHA256 signature rather than IAM, and the Lambda handler
 * (subtask 5.4) validates that signature against the per-server SSM secrets
 * before enqueueing anything (Requirements 3.1, 17.1). The handler reads both
 * MCP server secrets so it can verify deliveries from either server.
 *
 * Cross-stack wiring follows the design's CfnOutput / Fn.importValue approach
 * (same pattern as DataApiStack) so this stack stays environment agnostic:
 * imports the wildcard certificate ARN and subdomain hosted zone from DnsStack.
 * The queue ARN/URL are exported so AgentStack (which owns the agent Lambda)
 * can attach the queue as its SQS event source.
 *
 * HANDLER NOTE: The Lambda handler lives in the @mcp-events/webhook-receiver
 * package (subtask 5.4 creates src/handler.ts). It is not implemented yet, so
 * the NodejsFunction entry points at the existing placeholder src/index.ts so
 * this stack synthesizes today. Subtask 5.4 should repoint `entry` to
 * src/handler.ts.
 */
export class WebhookReceiverStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebhookReceiverStackProps) {
    super(scope, id, props);

    const domainName = resolveDomainName(props);
    const webhookDomainName = `webhook.${domainName}`;

    // --- SQS: dead-letter queue + main event queue --------------------------
    // Standard (not FIFO) queues so events for different customers process
    // concurrently (Requirement 19.5). Failed events move to the DLQ after
    // maxReceiveCount delivery attempts (Requirement 15.2: up to 3 attempts).
    const deadLetterQueue = new sqs.Queue(this, "EventDeadLetterQueue", {
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });

    const eventQueue = new sqs.Queue(this, "EventQueue", {
      enforceSSL: true,
      // The agent invokes the LLM per message, so give consumers ample time
      // before a message becomes visible again for retry.
      visibilityTimeout: cdk.Duration.seconds(300),
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: {
        queue: deadLetterQueue,
        maxReceiveCount: 3,
      },
    });

    // --- CloudWatch alarm on DLQ depth (Requirement 18.2) -------------------
    // Fire as soon as a single message lands in the DLQ; missing data (an empty
    // DLQ reports no datapoints) is treated as not breaching.
    new cloudwatch.Alarm(this, "DlqDepthAlarm", {
      alarmName: "earthquake-agent-webhook-dlq-depth",
      alarmDescription:
        "Alarms when messages accumulate in the Webhook Receiver dead-letter queue",
      metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: "Maximum",
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // --- SSM SecureString secrets for signature validation ------------------
    // The handler verifies each delivery's Standard Webhooks signature against
    // the originating server's secret. Both MCP server secrets are referenced
    // by their deterministic parameter names and read at runtime.
    const usgsHmacSecret =
      ssm.StringParameter.fromSecureStringParameterAttributes(
        this,
        "UsgsHmacSecretParameter",
        { parameterName: USGS_HMAC_SECRET_PARAMETER_NAME },
      );
    const schedulerHmacSecret =
      ssm.StringParameter.fromSecureStringParameterAttributes(
        this,
        "SchedulerHmacSecretParameter",
        { parameterName: SCHEDULER_HMAC_SECRET_PARAMETER_NAME },
      );

    // --- Lambda handler -------------------------------------------------------
    // Compiled stack lives at packages/cdk/dist/lib, so walk up to the repo's
    // packages/ directory to reach the webhook-receiver source and up to the
    // repo root for the workspace lock file (same pattern as DataApiStack).
    const webhookReceiverPackageRoot = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "webhook-receiver",
    );
    const handlerFn = new NodejsFunction(this, "WebhookReceiverHandler", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(webhookReceiverPackageRoot, "src", "index.ts"),
      handler: "handler",
      memorySize: 256,
      // Signature validation plus an SQS enqueue must finish well within the
      // webhook timeout (Requirement 19.2: under 100 ms of useful work), but
      // keep a safety margin for cold starts.
      timeout: cdk.Duration.seconds(10),
      depsLockFilePath: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "package-lock.json",
      ),
      environment: {
        EVENT_QUEUE_URL: eventQueue.queueUrl,
        USGS_HMAC_SECRET_PARAMETER_NAME,
        SCHEDULER_HMAC_SECRET_PARAMETER_NAME,
      },
    });

    // --- IAM grants (least privilege) ----------------------------------------
    eventQueue.grantSendMessages(handlerFn);
    usgsHmacSecret.grantRead(handlerFn);
    schedulerHmacSecret.grantRead(handlerFn);

    // --- API Gateway custom domain + REST API (open endpoint) ----------------
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      "WildcardCertificate",
      cdk.Fn.importValue("EarthquakeAgent-WildcardCertificateArn"),
    );

    const api = new apigateway.RestApi(this, "WebhookApi", {
      restApiName: "earthquake-agent-webhook-receiver",
      description:
        "Webhook Receiver HTTP endpoint for the MCP Events Serverless Agent sample (Standard Webhooks signature validated in the handler)",
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      domainName: {
        domainName: webhookDomainName,
        certificate,
        endpointType: apigateway.EndpointType.REGIONAL,
        securityPolicy: apigateway.SecurityPolicy.TLS_1_2,
      },
      deployOptions: {
        stageName: "prod",
      },
    });

    const integration = new apigateway.LambdaIntegration(handlerFn);

    // The endpoint is open (AuthorizationType.NONE): authenticity is enforced
    // by the Standard Webhooks signature the handler validates, not by IAM. A
    // greedy `{proxy+}` ANY route plus `/webhook` (POST) lets the MCP servers
    // post deliveries to the documented path.
    const noAuth: apigateway.MethodOptions = {
      authorizationType: apigateway.AuthorizationType.NONE,
    };

    const webhook = api.root.addResource("webhook");
    webhook.addMethod("POST", integration, noAuth);

    const proxy = api.root.addResource("{proxy+}");
    proxy.addMethod("ANY", integration, noAuth);

    // --- Route53 alias to the API custom domain ------------------------------
    const subdomainZone = route53.HostedZone.fromHostedZoneAttributes(
      this,
      "SubdomainZone",
      {
        hostedZoneId: cdk.Fn.importValue("EarthquakeAgent-SubdomainZoneId"),
        zoneName: domainName,
      },
    );

    new route53.ARecord(this, "WebhookAliasRecord", {
      zone: subdomainZone,
      recordName: webhookDomainName,
      target: route53.RecordTarget.fromAlias(
        new route53targets.ApiGatewayDomain(api.domainName!),
      ),
      comment:
        "Alias to the Webhook Receiver custom domain (webhook.earthquake-agent.*)",
    });

    // --- Cross-stack exports --------------------------------------------------
    new cdk.CfnOutput(this, "WebhookCustomDomainUrl", {
      value: `https://${webhookDomainName}`,
      description: "Custom domain URL of the Webhook Receiver endpoint",
      exportName: "EarthquakeAgent-WebhookCustomDomainUrl",
    });

    new cdk.CfnOutput(this, "WebhookQueueArn", {
      value: eventQueue.queueArn,
      description:
        "ARN of the SQS queue that buffers validated webhook events (consumed by AgentStack)",
      exportName: "EarthquakeAgent-WebhookQueueArn",
    });

    new cdk.CfnOutput(this, "WebhookQueueUrl", {
      value: eventQueue.queueUrl,
      description: "URL of the SQS queue that buffers validated webhook events",
      exportName: "EarthquakeAgent-WebhookQueueUrl",
    });

    new cdk.CfnOutput(this, "WebhookDeadLetterQueueArn", {
      value: deadLetterQueue.queueArn,
      description: "ARN of the Webhook Receiver dead-letter queue",
      exportName: "EarthquakeAgent-WebhookDeadLetterQueueArn",
    });
  }
}
