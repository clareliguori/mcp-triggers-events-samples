import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { resolveDomainName, type SharedProps } from "./shared-props.js";

export type DataApiStackProps = cdk.StackProps & SharedProps;

/**
 * Shared persistence layer (Data API) for the MCP Events Serverless Agent
 * sample.
 *
 * Responsibilities (Requirements 9.1, 9.2, 9.3, 9.8, 13.4, 13.5, 17.2, 17.3):
 * - API Gateway REST API at the custom domain `api.<subdomain>.<parentDomain>`
 *   (for example `api.earthquake-agent.liguori.people.aws.dev`).
 * - A single Lambda handler (proxy integration) that serves every Data API
 *   route (customer config CRUD, subscriptions, reports, session messages).
 * - DynamoDB tables: Customer Config (DynamoDB Stream enabled so the
 *   Subscription Manager can react to new customers) and Subscriptions (with a
 *   global secondary index on `customerId` for per-customer lookups).
 * - A customer-managed KMS key for client-side field encryption of the
 *   per-subscription webhook secret stored in the Subscriptions table. The Data
 *   API Lambda owns AND uses this key: it encrypts the `secret` attribute with
 *   `kms:Encrypt` before writing (PutItem/UpdateItem) and decrypts it with
 *   `kms:Decrypt` after reading (GetItem), so DynamoDB only ever holds
 *   ciphertext. Callers (Subscription Manager on store, Webhook Receiver on
 *   read) always exchange the plaintext `whsec_` with the Data API over
 *   IAM-authed HTTPS and hold no KMS permissions. This key is used ONLY by the
 *   Data API Lambda within this stack — it is NOT exported and NOT granted
 *   cross-stack (Requirements 17.5, 17.8).
 * - An S3 bucket for briefing reports laid out as
 *   `reports/{customerId}/{reportId}.json`.
 * - Dual authorization: a Cognito User Pool Authorizer for the webapp and IAM
 *   authorization for the backend services (Serverless Agent, Subscription
 *   Manager). See the authorization note below.
 * - CORS restricted to the CloudFront webapp origin only (Requirement 17.2).
 * - Read-only `s3:GetObject` on the AgentStack sessions bucket so the read-only
 *   `GET /customers/:customerId/session/messages` endpoint can return the
 *   agent's conversation history (Requirements 9.8, 17.3).
 *
 * Cross-stack wiring follows the design's CfnOutput / Fn.importValue approach
 * so this stack stays environment agnostic (see bin/app.ts):
 * - Imports the wildcard certificate ARN and subdomain hosted zone from
 *   DnsStack (same pattern as AuthStack).
 * - Imports the Cognito User Pool id from AuthStack.
 * - Imports the sessions bucket ARN from AgentStack.
 *
 * IMPORTANT cross-stack contract for subtask 2.5 (AgentStack): AgentStack MUST
 * export its sessions bucket ARN under the export name
 * `EarthquakeAgent-SessionsBucketArn`. This stack imports that exact name via
 * `cdk.Fn.importValue`. The import is a deploy-time CloudFormation intrinsic,
 * so `cdk synth DataApiStack` succeeds even before AgentStack exists; the
 * export only needs to be present at deploy time.
 *
 * AUTHORIZATION NOTE (dual authorizers): An API Gateway REST API method accepts
 * exactly one `authorizationType`, so a single path+method cannot literally
 * carry both a Cognito authorizer and IAM authorization. To realize the
 * design's dual-auth intent on the same route surface:
 * - Webapp-facing routes are declared explicitly with the Cognito User Pool
 *   Authorizer (interactive human users present a JWT bearer token).
 * - Backend-only routes (subscription lookups, report writes) are declared
 *   explicitly with IAM authorization (the Serverless Agent and Subscription
 *   Manager sign requests with SigV4).
 * - A greedy `{proxy+}` ANY method with IAM authorization gives the backend
 *   SigV4 callers an IAM-authorized path across the rest of the API surface.
 *   Explicit resources take routing precedence over the proxy, so a path+method
 *   declared with Cognito is served by Cognito; everything else falls through
 *   to the IAM proxy. Both authorizer mechanisms therefore protect the same
 *   API. The handler (subtask 4.1) inspects `requestContext` to distinguish the
 *   caller type and enforce per-customer access rules.
 *
 * Because explicit resources win over `{proxy+}`, a backend SigV4 caller that
 * needs to read a resource exposed to the webapp under Cognito CANNOT reach it
 * through the IAM proxy — the explicit Cognito method intercepts the path and
 * rejects the unsigned-by-Cognito request with 401. Backend reads of such
 * resources are therefore given their own explicit IAM-authorized path under a
 * `/backend/...` namespace (for example `GET /backend/customers/{customerId}/
 * config`, which the Serverless Agent calls to load a customer's config). The
 * webapp keeps the Cognito `/customers/{customerId}/config` route untouched,
 * and the backend path resolves to the same handler logic in the Data API
 * Lambda.
 */
export class DataApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DataApiStackProps) {
    super(scope, id, props);

    const domainName = resolveDomainName(props);
    const apiDomainName = `api.${domainName}`;
    const appOrigin = `https://app.${domainName}`;
    // CORS allowlist. The CloudFront webapp origin is always allowed
    // (Requirement 17.2); the webapp dev server (Vite, http://localhost:5173)
    // is also always allowed so the local dev server can call the deployed Data
    // API from the browser during development. Both are explicit origins (no
    // wildcard) and the handler reflects only the matching request origin, so
    // credentialed CORS still works and no other origin is granted access.
    const localhostOrigin = "http://localhost:5173";
    const corsOrigins = [appOrigin, localhostOrigin];
    // The handler reads the allowlist from ALLOWED_ORIGIN as a comma-separated
    // list and reflects the matching request origin (credentialed CORS cannot
    // use a wildcard).
    const allowedOriginEnv = corsOrigins.join(",");
    // MCP Server 2 (Message Scheduler) lives at a deterministic custom domain
    // created by SchedulerServerStack (subtask 2.4). The Data API Lambda's
    // manual-trigger route (subtask 4.5) calls it via IAM-signed HTTP, so we
    // pass the URL as an environment variable rather than a cross-stack import
    // to avoid a synth-time ordering dependency on a stack that does not exist
    // yet.
    const schedulerMcpUrl = `https://scheduler-mcp.${domainName}`;

    const subscriptionsByCustomerIndex = "by-customer-id";

    // --- DynamoDB: Customer Config (stream enabled) ---------------------------
    // customerId (= Cognito "sub") is the partition key. The stream feeds the
    // Subscription Manager when a new customer registers (Requirement 8.1).
    const customerConfigTable = new dynamodb.Table(
      this,
      "CustomerConfigTable",
      {
        partitionKey: {
          name: "customerId",
          type: dynamodb.AttributeType.STRING,
        },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
        pointInTimeRecoverySpecification: {
          pointInTimeRecoveryEnabled: true,
        },
        // Demo sample: tear the table down cleanly with the stack.
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );

    // --- DynamoDB: Subscriptions (GSI on customerId) --------------------------
    // subscriptionId is the partition key (used by the agent to resolve
    // subscriptionId -> customerId). The GSI on customerId supports listing all
    // subscriptions for a customer (Requirement 9.7).
    const subscriptionsTable = new dynamodb.Table(this, "SubscriptionsTable", {
      partitionKey: {
        name: "subscriptionId",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    subscriptionsTable.addGlobalSecondaryIndex({
      indexName: subscriptionsByCustomerIndex,
      partitionKey: { name: "customerId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // --- KMS: per-table key for client-side secret encryption ----------------
    // The per-subscription Standard Webhooks secret is client-side field-
    // encrypted with this customer-managed key by the Data API Lambda BEFORE
    // being written to the Subscriptions table, and decrypted after reading, so
    // DynamoDB only ever holds ciphertext (Requirement 17.5). This key is owned
    // AND used by the Data API Lambda only; it is NOT exported and NOT granted
    // to any other stack (Requirement 17.8). Callers exchange the plaintext
    // `whsec_` with the Data API over IAM-authed HTTPS. Key rotation is enabled;
    // the key is destroyed with the demo stack.
    const subscriptionSecretKey = new kms.Key(this, "SubscriptionSecretKey", {
      description:
        "Client-side encryption key for per-subscription webhook secrets in the Data API Subscriptions table",
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    subscriptionSecretKey.addAlias(
      "alias/earthquake-agent/data-api-subscription-secret",
    );

    // --- S3: Briefing reports bucket -----------------------------------------
    // Reports are stored at reports/{customerId}/{reportId}.json (Requirement
    // 9.6). The bucket is private; the Data API Lambda is the only reader and
    // writer.
    const reportsBucket = new s3.Bucket(this, "ReportsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Demo sample: remove the bucket and its contents with the stack.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // --- Cross-stack imports --------------------------------------------------
    // Sessions bucket ARN is exported by AgentStack (subtask 2.5). Imported as a
    // deploy-time intrinsic so synth works before AgentStack exists.
    const sessionsBucketArn = cdk.Fn.importValue(
      "EarthquakeAgent-SessionsBucketArn",
    );
    // Derive the bucket name from the ARN (arn:aws:s3:::<name>) so the handler
    // can address objects without a second cross-stack export.
    const sessionsBucketName = cdk.Fn.select(
      5,
      cdk.Fn.split(":", sessionsBucketArn),
    );

    const userPool = cognito.UserPool.fromUserPoolId(
      this,
      "UserPool",
      cdk.Fn.importValue("EarthquakeAgent-UserPoolId"),
    );

    // --- Lambda handler -------------------------------------------------------
    // The Data API handler is implemented in the @mcp-events/data-api package
    // (subtask 4.1 creates src/handler.ts). It is not implemented yet, so the
    // NodejsFunction entry points at the existing placeholder src/index.ts so
    // this stack synthesizes today. Subtask 4.1 should repoint `entry` to
    // src/handler.ts (and keep `handler: "index.handler"` or update to match).
    // esbuild bundles the TypeScript source directly, which is the idiomatic
    // approach for this workspace monorepo.
    //
    // Path note: this stack compiles to packages/cdk/dist/lib, so __dirname at
    // synth time is packages/cdk/dist/lib. Walk up to the repo's packages/
    // directory to reach the data-api package source and up to the repo root
    // for the workspace lock file.
    const dataApiPackageRoot = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "data-api",
    );
    const handlerFn = new NodejsFunction(this, "DataApiHandler", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(dataApiPackageRoot, "src", "index.ts"),
      handler: "handler",
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      depsLockFilePath: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "package-lock.json",
      ),
      environment: {
        CUSTOMER_CONFIG_TABLE_NAME: customerConfigTable.tableName,
        SUBSCRIPTIONS_TABLE_NAME: subscriptionsTable.tableName,
        SUBSCRIPTIONS_BY_CUSTOMER_INDEX: subscriptionsByCustomerIndex,
        REPORTS_BUCKET_NAME: reportsBucket.bucketName,
        SESSIONS_BUCKET_NAME: sessionsBucketName,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        ALLOWED_ORIGIN: allowedOriginEnv,
        SCHEDULER_MCP_URL: schedulerMcpUrl,
        SUBSCRIPTION_SECRET_KEY_ID: subscriptionSecretKey.keyArn,
      },
    });

    // --- IAM grants (least privilege) ----------------------------------------
    customerConfigTable.grantReadWriteData(handlerFn);
    subscriptionsTable.grantReadWriteData(handlerFn);
    reportsBucket.grantReadWrite(handlerFn);
    // kms:Encrypt/Decrypt on the Subscriptions table key so the Data API Lambda
    // can client-side field-encrypt the secret attribute on write and decrypt
    // it on read (Requirement 17.5). This key is used only by this Lambda.
    subscriptionSecretKey.grantEncryptDecrypt(handlerFn);

    // Read-only access to the AgentStack sessions bucket for the read-only
    // session messages endpoint (Requirements 9.8, 17.3). The agent still owns
    // writes to this bucket.
    //
    // s3:GetObject is scoped to the sessions/ prefix. s3:ListBucket is granted
    // on the bucket itself (no s3:prefix condition): without it, a GetObject of
    // a not-yet-created session snapshot returns 403 AccessDenied instead of 404
    // NoSuchKey, which the handler cannot distinguish from a real auth failure
    // and surfaces as a 500. The list-permission check S3 runs to decide 404 vs
    // 403 carries no s3:prefix, so a prefix-conditioned grant would not satisfy
    // it — hence the bucket-wide (still read-only) ListBucket.
    handlerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [`${sessionsBucketArn}/sessions/*`],
      }),
    );
    handlerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [sessionsBucketArn],
      }),
    );

    // The manual-trigger route (subtask 4.5) invokes MCP Server 2 via IAM auth.
    // Allow execute-api:Invoke against the scheduler MCP API in this account and
    // region. The concrete API id is not known here (SchedulerServerStack is
    // created later), so the resource is scoped to this account/region's API
    // Gateway execute-api namespace.
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

    // --- API Gateway custom domain + REST API --------------------------------
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      "WildcardCertificate",
      cdk.Fn.importValue("EarthquakeAgent-RegionalWildcardCertificateArn"),
    );

    const api = new apigateway.RestApi(this, "DataApi", {
      restApiName: "earthquake-agent-data-api",
      description:
        "Shared Data API for the MCP Events Serverless Agent sample (config, subscriptions, reports, session messages)",
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      domainName: {
        domainName: apiDomainName,
        certificate,
        endpointType: apigateway.EndpointType.REGIONAL,
        securityPolicy: apigateway.SecurityPolicy.TLS_1_2,
      },
      // CORS restricted to the allowlist (CloudFront webapp origin and the
      // localhost dev origin), with credentials enabled for the JWT bearer flow
      // (Requirement 17.2). No wildcard origin.
      defaultCorsPreflightOptions: {
        allowOrigins: corsOrigins,
        allowCredentials: true,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: [
          "Authorization",
          "Content-Type",
          "X-Amz-Date",
          "X-Amz-Security-Token",
          "X-Api-Key",
        ],
      },
      deployOptions: {
        stageName: "prod",
      },
    });

    const integration = new apigateway.LambdaIntegration(handlerFn);

    const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      "CognitoAuthorizer",
      {
        cognitoUserPools: [userPool],
        authorizerName: "earthquake-agent-cognito-authorizer",
      },
    );

    // Method options for each authorizer flavor.
    const cognitoAuth: apigateway.MethodOptions = {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: cognitoAuthorizer,
    };
    const iamAuth: apigateway.MethodOptions = {
      authorizationType: apigateway.AuthorizationType.IAM,
    };

    // Resource tree:
    //   /customers/{customerId}/config            GET/PUT/DELETE  (Cognito)
    //   /customers/{customerId}/subscriptions     GET/POST        (IAM)
    //   /customers/{customerId}/reports           GET (Cognito), POST (IAM)
    //   /customers/{customerId}/reports/{reportId}GET             (Cognito)
    //   /customers/{customerId}/session/messages  GET             (Cognito)
    //   /backend/customers/{customerId}/config    GET             (IAM)
    //   /subscriptions/{subscriptionId}           GET/PUT         (IAM)
    //   /trigger-briefing/{customerId}            POST            (Cognito)
    //   /{proxy+}                                 ANY             (IAM fallback)
    const customers = api.root.addResource("customers");
    const customer = customers.addResource("{customerId}");

    const config = customer.addResource("config");
    config.addMethod("GET", integration, cognitoAuth);
    config.addMethod("PUT", integration, cognitoAuth);
    config.addMethod("DELETE", integration, cognitoAuth);

    const customerSubscriptions = customer.addResource("subscriptions");
    customerSubscriptions.addMethod("GET", integration, iamAuth);
    customerSubscriptions.addMethod("POST", integration, iamAuth);

    const reports = customer.addResource("reports");
    reports.addMethod("GET", integration, cognitoAuth);
    reports.addMethod("POST", integration, iamAuth);
    const report = reports.addResource("{reportId}");
    report.addMethod("GET", integration, cognitoAuth);

    const session = customer.addResource("session");
    const sessionMessages = session.addResource("messages");
    sessionMessages.addMethod("GET", integration, cognitoAuth);

    const subscriptions = api.root.addResource("subscriptions");
    const subscription = subscriptions.addResource("{subscriptionId}");
    subscription.addMethod("GET", integration, iamAuth);
    subscription.addMethod("PUT", integration, iamAuth);

    const triggerBriefing = api.root.addResource("trigger-briefing");
    const triggerBriefingCustomer = triggerBriefing.addResource("{customerId}");
    triggerBriefingCustomer.addMethod("POST", integration, cognitoAuth);

    // Explicit IAM-authorized backend route for the Serverless Agent to read a
    // customer's config (Requirements 9.3, 17.7). The webapp-facing
    // /customers/{customerId}/config route is Cognito-only, and because
    // explicit resources win over {proxy+}, a SigV4-signed backend read of that
    // path would hit the Cognito method and be rejected with 401. Giving the
    // backend its own explicit IAM path under /backend keeps it unambiguous and
    // testable, consistent with the existing "webapp = Cognito, backend = IAM"
    // split. It resolves to the same config GET handler in the Data API Lambda.
    const backend = api.root.addResource("backend");
    const backendCustomers = backend.addResource("customers");
    const backendCustomer = backendCustomers.addResource("{customerId}");
    const backendConfig = backendCustomer.addResource("config");
    backendConfig.addMethod("GET", integration, iamAuth);

    // IAM-authorized greedy fallback so backend SigV4 callers have an
    // IAM-protected path across the rest of the API surface (see the
    // authorization note in the class doc comment).
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

    new route53.ARecord(this, "DataApiAliasRecord", {
      zone: subdomainZone,
      recordName: apiDomainName,
      target: route53.RecordTarget.fromAlias(
        new route53targets.ApiGatewayDomain(api.domainName!),
      ),
      comment: "Alias to the Data API custom domain (api.earthquake-agent.*)",
    });

    // --- Cross-stack exports --------------------------------------------------
    new cdk.CfnOutput(this, "DataApiUrl", {
      value: api.url,
      description: "Invoke URL of the Data API",
      exportName: "EarthquakeAgent-DataApiUrl",
    });

    new cdk.CfnOutput(this, "DataApiCustomDomainUrl", {
      value: `https://${apiDomainName}`,
      description: "Custom domain URL of the Data API",
      exportName: "EarthquakeAgent-DataApiCustomDomainUrl",
    });

    new cdk.CfnOutput(this, "CustomerConfigTableArn", {
      value: customerConfigTable.tableArn,
      description: "ARN of the Customer Config DynamoDB table",
      exportName: "EarthquakeAgent-CustomerConfigTableArn",
    });

    new cdk.CfnOutput(this, "CustomerConfigTableName", {
      value: customerConfigTable.tableName,
      description: "Name of the Customer Config DynamoDB table",
      exportName: "EarthquakeAgent-CustomerConfigTableName",
    });

    new cdk.CfnOutput(this, "CustomerConfigStreamArn", {
      // streamArn is optional on the type; the stream is enabled above so it is
      // always present at synth time.
      value: customerConfigTable.tableStreamArn ?? "",
      description:
        "Stream ARN of the Customer Config DynamoDB table (consumed by the Subscription Manager)",
      exportName: "EarthquakeAgent-CustomerConfigStreamArn",
    });

    new cdk.CfnOutput(this, "SubscriptionsTableArn", {
      value: subscriptionsTable.tableArn,
      description: "ARN of the Subscriptions DynamoDB table",
      exportName: "EarthquakeAgent-SubscriptionsTableArn",
    });

    new cdk.CfnOutput(this, "SubscriptionsTableName", {
      value: subscriptionsTable.tableName,
      description: "Name of the Subscriptions DynamoDB table",
      exportName: "EarthquakeAgent-SubscriptionsTableName",
    });

    new cdk.CfnOutput(this, "ReportsBucketName", {
      value: reportsBucket.bucketName,
      description: "Name of the S3 bucket that stores briefing reports",
      exportName: "EarthquakeAgent-ReportsBucketName",
    });
  }
}
