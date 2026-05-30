import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { DynamoEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { Construct } from "constructs";
import { resolveDomainName, type SharedProps } from "./shared-props.js";

export type SubscriptionManagerStackProps = cdk.StackProps & SharedProps;

/**
 * Subscription Manager stack for the MCP Events Serverless Agent sample.
 *
 * Responsibilities (Requirements 8.x, 13.4, 13.5, 14.6, 17.3, 17.7, 17.9):
 * - A Lambda with dual triggers:
 *   1. The CustomerConfig DynamoDB Stream (from DataApiStack) so a new or
 *      updated customer immediately gets webhook subscriptions created on both
 *      MCP servers (Requirement 8.1).
 *   2. An EventBridge rule firing every 5 minutes to refresh subscriptions that
 *      are nearing expiry and re-create any that went missing (Requirement
 *      8.2).
 * - A least-privilege execution role granting `execute-api:Invoke` so the
 *   Lambda can call the MCP servers' `events/subscribe` method and the Data API
 *   (all via SigV4-signed HTTP using StreamableHTTPClientWithSigV4Transport)
 *   (Requirements 14.6, 17.7), plus DynamoDB Stream read on the CustomerConfig
 *   stream. It generates each subscription's `whsec_` secret and passes the
 *   plaintext value to the Data API over IAM-authed HTTPS; the Data API
 *   client-side encrypts it at its storage boundary. The Subscription Manager
 *   therefore holds NO KMS permissions (Requirement 17.9).
 *
 * STREAM TRIGGER NOTE: DataApiStack owns the CustomerConfig table and exports
 * its stream ARN as `EarthquakeAgent-CustomerConfigStreamArn`. We import that
 * ARN and reconstruct an `ITable` via `dynamodb.Table.fromTableAttributes`
 * (passing `tableStreamArn`) so we can use the high-level `DynamoEventSource`.
 * `DynamoEventSource.bind` calls `grantStreamRead` on the imported table, which
 * adds the `dynamodb:DescribeStream`/`GetRecords`/`GetShardIterator` permissions
 * plus a `dynamodb:ListStreams` on `*`, so no manual stream IAM policy is
 * needed. Using the imported-table + `DynamoEventSource` approach (rather than a
 * bare `EventSourceMapping`) keeps the wiring idiomatic and synthesizes cleanly
 * in aws-cdk-lib 2.230 because `Fn.importValue` for the stream ARN is a
 * deploy-time intrinsic.
 *
 * Cross-stack wiring follows the design's CfnOutput / Fn.importValue approach
 * so this stack stays environment agnostic. The MCP server and Data API custom
 * domain URLs are deterministic, so they are passed as environment variables
 * rather than cross-stack imports to avoid synth-time ordering dependencies
 * (same approach the MCP server stacks use for the webhook URL).
 *
 * HANDLER NOTE: The Lambda handler lives in the @mcp-events/subscription-manager
 * package (subtask 10.4 creates src/handler.ts). It is not implemented yet, so
 * the NodejsFunction entry points at the existing placeholder src/index.ts so
 * this stack synthesizes today. Subtask 10.4 should repoint `entry` to
 * src/handler.ts.
 */
export class SubscriptionManagerStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: SubscriptionManagerStackProps,
  ) {
    super(scope, id, props);

    const domainName = resolveDomainName(props);
    // Deterministic custom domains created by their respective stacks. Passed
    // as environment variables to avoid synth-time ordering dependencies.
    const dataApiUrl = `https://api.${domainName}`;
    const usgsMcpUrl = `https://usgs-mcp.${domainName}/mcp`;
    const schedulerMcpUrl = `https://scheduler-mcp.${domainName}/mcp`;

    // --- Lambda handler -------------------------------------------------------
    // Compiled stack lives at packages/cdk/dist/lib, so walk up to the repo's
    // packages/ directory to reach the subscription-manager source and up to
    // the repo root for the workspace lock file (same pattern as DataApiStack).
    const subscriptionManagerPackageRoot = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "subscription-manager",
    );
    const handlerFn = new NodejsFunction(this, "SubscriptionManagerHandler", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(subscriptionManagerPackageRoot, "src", "index.ts"),
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
        DATA_API_URL: dataApiUrl,
        USGS_MCP_URL: usgsMcpUrl,
        SCHEDULER_MCP_URL: schedulerMcpUrl,
      },
    });

    // --- DynamoDB Stream trigger (new/updated customers) ---------------------
    // Reconstruct the CustomerConfig table from its exported table ARN and
    // stream ARN so the high-level DynamoEventSource can attach to it and wire
    // stream-read IAM. `fromTableAttributes` requires a table ARN (or name) in
    // addition to the stream ARN, so both are imported from DataApiStack.
    const customerConfigTable = dynamodb.Table.fromTableAttributes(
      this,
      "CustomerConfigTable",
      {
        tableArn: cdk.Fn.importValue("EarthquakeAgent-CustomerConfigTableArn"),
        tableStreamArn: cdk.Fn.importValue(
          "EarthquakeAgent-CustomerConfigStreamArn",
        ),
      },
    );
    handlerFn.addEventSource(
      new DynamoEventSource(customerConfigTable, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 5,
        retryAttempts: 3,
        reportBatchItemFailures: true,
      }),
    );

    // --- EventBridge trigger (scheduled refresh every 5 minutes) -------------
    new events.Rule(this, "RefreshSchedule", {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      description:
        "Triggers the Subscription Manager to refresh expiring webhook subscriptions every 5 minutes",
      targets: [new targets.LambdaFunction(handlerFn)],
    });

    // --- IAM grants (least privilege) ----------------------------------------
    // execute-api:Invoke so the Lambda can call the MCP servers'
    // events/subscribe method and the Data API via SigV4-signed HTTP
    // (Requirements 14.6, 17.7). The concrete API ids are not known here (those
    // stacks are created separately and do not export ids), so scope the grant
    // to this account/region's execute-api namespace (same approach as
    // DataApiStack and AgentStack).
    handlerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["execute-api:Invoke"],
        resources: [
          cdk.Stack.of(this).formatArn({
            service: "execute-api",
            resource: "*",
            arnFormat: cdk.ArnFormat.NO_RESOURCE_NAME,
          }),
        ],
      }),
    );
  }
}
