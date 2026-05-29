# Implementation Plan: MCP Events Serverless Agent — Earthquake Monitoring

## Overview

This implementation plan breaks the multi-stack CDK application into incremental coding tasks. The system demonstrates the MCP Events extension using webhook delivery mode to wake a serverless Strands Agent for earthquake monitoring. Tasks are ordered so foundational pieces (project scaffolding, shared types, CDK base) come first, then individual components can be built in parallel, with integration testing last.

## Tasks

- [-] 1. Project scaffolding and shared types
  - [x] 1.1 Initialize monorepo structure with TypeScript configuration
    - Create root `package.json` with workspaces for `packages/shared`, `packages/cdk`, `packages/data-api`, `packages/usgs-server`, `packages/scheduler-server`, `packages/webhook-receiver`, `packages/agent`, `packages/subscription-manager`, `packages/webapp`
    - Create root `tsconfig.json` with project references
    - Create per-package `tsconfig.json` files extending root config
    - Add `vitest` and `fast-check` as dev dependencies at root
    - Add `aws-cdk-lib`, `constructs`, `@strands-agents/sdk`, `@modelcontextprotocol/sdk`, `@aws/run-mcp-servers-with-aws-lambda`, `@deliveryhero/dynamodb-lock`, `standard-webhooks`, `zod` dependencies
    - _Requirements: 13.1_
    - _Validation: `npm install` succeeds without errors; `npx tsc --noEmit` compiles without errors across all packages_

  - [x] 1.2 Define shared TypeScript interfaces and data models
    - Create `packages/shared/src/models.ts` with all data model interfaces: `CustomerConfig`, `McpEventPayload`, `EarthquakeDetectedData`, `BriefingTriggerData`, `CustomerSessionLock`, `WebhookSubscription`, `AgentSessionState`, `BriefingReport`, `NotableQuake`, `SubscribeParams`, `SubscribeResult`, `UsgsCursorState`, `ReportSummary`
    - Create `packages/shared/src/validation.ts` with zod schemas for all models (CustomerConfig input validation, event payload validation, subscription params validation)
    - Create `packages/shared/src/constants.ts` with shared constants (region list, magnitude bounds, cron validation regex, TTL defaults)
    - Export all types and schemas from `packages/shared/src/index.ts`
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6_
    - _Validation: `npx tsc --noEmit` compiles without errors; import the types in a test file and verify they're accessible_

  - [x] 1.3 Write property test for input validation (Property 12)
    - **Property 12: Input Validation Correctness**
    - Generate arbitrary CustomerConfig inputs with fast-check and verify that valid inputs are accepted and invalid inputs are rejected with HTTP 400 semantics
    - Test UUID v4 format validation, minMagnitude in [0,10], region enum, briefingPrompt length, cron expression validity
    - **Validates: Requirements 16.1, 16.2, 16.3, 16.4, 16.5, 16.6**
    - _Validation: `npx vitest run <test-file>` passes all property tests; tests generate at least 100 random inputs_

- [ ] 2. CDK infrastructure — base stacks and DNS
  - [~] 2.1 Create CDK app entry point and shared infrastructure
    - Create `packages/cdk/bin/app.ts` with CDK app instantiation and all stack definitions
    - Create `packages/cdk/lib/shared-props.ts` with `SharedProps` interface (parentDomain, subdomain)
    - Create `packages/cdk/lib/dns-stack.ts` for Route53 subdomain zone creation, NS delegation from parent zone, and ACM wildcard certificate with DNS validation
    - _Requirements: 13.1, 13.2, 13.3_
    - _Validation: `npx tsc --noEmit` compiles without errors; `npx cdk synth DnsStack` produces valid CloudFormation template; template contains AWS::Route53::HostedZone and AWS::CertificateManager::Certificate resources_

  - [~] 2.2 Implement AuthStack (Cognito)
    - Create `packages/cdk/lib/auth-stack.ts` with Cognito User Pool, User Pool Client (authorization code flow with PKCE), hosted UI domain at `auth.earthquake-agent.<parentDomain>`
    - Export User Pool ID, Client ID, and hosted UI domain via CfnOutput
    - _Requirements: 13.4, 13.5, 10.1_
    - _Validation: `npx tsc --noEmit` compiles without errors; `npx cdk synth AuthStack` produces valid CloudFormation template; template contains AWS::Cognito::UserPool and AWS::Cognito::UserPoolClient resources_

  - [~] 2.3 Implement DataApiStack
    - Create `packages/cdk/lib/data-api-stack.ts` with API Gateway (custom domain `api.earthquake-agent.<parentDomain>`), Lambda handler, DynamoDB tables (CustomerConfig with stream enabled, Subscriptions with GSI on customerId), S3 reports bucket
    - Configure dual authorizers: Cognito User Pool Authorizer + IAM Authorizer on same routes
    - Configure CORS for CloudFront origin only
    - Grant Data API Lambda `s3:GetObject` on AgentStack's sessions bucket (cross-stack import of sessions bucket ARN) for the read-only session messages endpoint
    - Export API URL, table ARNs, stream ARN via CfnOutput
    - _Requirements: 9.1, 9.2, 9.3, 9.8, 13.4, 13.5, 17.2, 17.3_
    - _Validation: `npx tsc --noEmit` compiles without errors; `npx cdk synth DataApiStack` produces valid CloudFormation template; template contains AWS::ApiGateway::RestApi, AWS::Lambda::Function, AWS::DynamoDB::Table, and AWS::S3::Bucket resources_

  - [~] 2.4 Implement UsgsServerStack and SchedulerServerStack
    - Create `packages/cdk/lib/usgs-server-stack.ts` with API Gateway (IAM auth, custom domain `usgs-mcp.earthquake-agent.<parentDomain>`), Lambda, DynamoDB tables (Cursor State, Subscriptions), EventBridge rule (every 5 min), SSM SecureString for HMAC secret
    - Create `packages/cdk/lib/scheduler-server-stack.ts` with API Gateway (IAM auth, custom domain `scheduler-mcp.earthquake-agent.<parentDomain>`), Lambda, DynamoDB table (Subscriptions), EventBridge rule (every 1 min), SSM SecureString for HMAC secret
    - Export API URLs via CfnOutput
    - _Requirements: 13.4, 13.5, 17.5, 17.6_
    - _Validation: `npx tsc --noEmit` compiles without errors; `npx cdk synth UsgsServerStack SchedulerServerStack` produces valid CloudFormation templates; templates contain AWS::ApiGateway::RestApi, AWS::Lambda::Function, AWS::DynamoDB::Table, and AWS::Events::Rule resources_

  - [~] 2.5 Implement WebhookReceiverStack, AgentStack, SubscriptionManagerStack, and WebappStack
    - Create `packages/cdk/lib/webhook-receiver-stack.ts` with API Gateway (custom domain `webhook.earthquake-agent.<parentDomain>`), Lambda, SQS queue + DLQ, CloudWatch alarm on DLQ depth
    - Create `packages/cdk/lib/agent-stack.ts` with Lambda (SQS trigger, batch size 1), S3 sessions bucket, DynamoDB session locks table, IAM role with execute-api:Invoke on Data API
    - Export sessions bucket ARN via CfnOutput for cross-stack read-only access by DataApiStack
    - Create `packages/cdk/lib/subscription-manager-stack.ts` with Lambda (dual triggers: DynamoDB Stream from CustomerConfig + EventBridge every 5 min), IAM role with execute-api:Invoke on MCP server API Gateways and Data API
    - Create `packages/cdk/lib/webapp-stack.ts` with S3 bucket, CloudFront distribution (custom domain `app.earthquake-agent.<parentDomain>`, OAC), response headers policy
    - _Requirements: 13.1, 13.4, 13.5, 17.3, 17.4, 18.2, 19.4, 19.5_
    - _Validation: `npx tsc --noEmit` compiles without errors; `npx cdk synth WebhookReceiverStack AgentStack SubscriptionManagerStack WebappStack` produces valid CloudFormation templates; templates contain expected resources (SQS, Lambda, S3, CloudFront)_

- [~] 3. Checkpoint — Verify CDK synth
  - Ensure `cdk synth` succeeds for all stacks, ask the user if questions arise.
  - _Validation: All preceding tasks' validations pass; `npx tsc --noEmit` compiles entire monorepo; `npx cdk synth` succeeds for all stacks_

- [ ] 4. Data API Lambda handlers
  - [~] 4.1 Implement Data API Lambda handler with routing and authorization
    - Create `packages/data-api/src/handler.ts` with API Gateway proxy event handler
    - Implement route matching for all Data API routes (config CRUD, subscriptions, reports, trigger-briefing)
    - Implement dual authorization logic: extract auth type from `requestContext.authorizer`, enforce customerId == JWT sub for Cognito callers, allow IAM callers access to any customer
    - Return appropriate HTTP status codes (400, 403, 404, 500)
    - _Requirements: 9.1, 9.2, 9.3, 5.3_
    - _Validation: `npx tsc --noEmit` compiles without errors; `npx vitest run` passes unit tests for the handler; `npx eslint packages/data-api/src/handler.ts`_

  - [~] 4.2 Write property test for Cognito authorization enforcement (Property 11)
    - **Property 11: Cognito Authorization Enforcement**
    - Generate arbitrary customerId and JWT sub pairs with fast-check, verify that mismatches always return 403 and matches always allow access
    - **Validates: Requirements 5.3, 9.2**
    - _Validation: `npx vitest run <test-file>` passes all property tests; tests generate at least 100 random inputs_

  - [~] 4.3 Implement CustomerConfig CRUD operations
    - Create `packages/data-api/src/routes/config.ts` with GET, PUT, DELETE handlers for `/customers/:customerId/config`
    - Validate input with zod schemas from shared package
    - DynamoDB PutItem/GetItem/UpdateItem operations
    - PUT sets `active: true`, `createdAt`/`updatedAt` timestamps; DELETE sets `active: false`
    - _Requirements: 9.5, 16.1, 16.2, 16.3, 16.4, 16.5, 16.6_
    - _Validation: `npx tsc --noEmit` compiles without errors; `npx vitest run` passes unit tests for the handler; `npx eslint packages/data-api/src/routes/config.ts`_

  - [~] 4.4 Implement Subscription and Report operations
    - Create `packages/data-api/src/routes/subscriptions.ts` with GET by subscriptionId, GET by customerId, POST, PUT handlers
    - Create `packages/data-api/src/routes/reports.ts` with GET list (supports `?latest=true`), GET by reportId, POST handlers
    - Reports stored in S3 at `reports/{customerId}/{reportId}.json`
    - Subscription lookup by subscriptionId returns associated customerId for event routing
    - _Requirements: 9.6, 9.7, 5.4_
    - _Validation: `npx tsc --noEmit` compiles without errors; `npx vitest run` passes unit tests for the handler; `npx eslint packages/data-api/src/routes/subscriptions.ts packages/data-api/src/routes/reports.ts`_

  - [~] 4.5 Implement manual trigger endpoint
    - Create `packages/data-api/src/routes/trigger.ts` with `POST /trigger-briefing/:customerId` handler
    - Invoke MCP Server 2's manual trigger endpoint via IAM-signed HTTP request
    - Require Cognito JWT authorization, validate customerId matches JWT sub
    - _Requirements: 2.4, 10.5_
    - _Validation: `npx tsc --noEmit` compiles without errors; `npx vitest run` passes unit tests for the handler; `npx eslint packages/data-api/src/routes/trigger.ts`_

  - [~] 4.6 Implement session messages read-only endpoint
    - Create `packages/data-api/src/routes/session.ts` with `GET /customers/:customerId/session/messages` handler
    - Read the session snapshot from the sessions S3 bucket at `sessions/{customerId}/session.json` using `s3:GetObject` (read-only access)
    - Extract and return the `messages` array from the session snapshot
    - Enforce same authorization as other routes (Cognito: customerId must match JWT sub; IAM: allow any customer)
    - Handle missing session gracefully (return empty messages array)
    - _Requirements: 9.8, 10.7_
    - _Validation: `npx tsc --noEmit` compiles without errors; `npx vitest run` passes unit tests for the handler; `npx eslint packages/data-api/src/routes/session.ts`_

- [ ] 5. Webhook Receiver
  - [~] 5.1 Implement Standard Webhooks signature validation library
    - Create `packages/webhook-receiver/src/signature.ts` with HMAC-SHA256 signing and verification functions
    - Implement timestamp tolerance check (5-minute window)
    - Support multiple server secrets (one per MCP server)
    - Use the `standard-webhooks` npm package for compliance
    - _Requirements: 3.1, 3.2, 3.3, 17.1_
    - _Validation: `npx tsc --noEmit` compiles without errors; `npx vitest run` passes unit tests for the handler; `npx eslint packages/webhook-receiver/src/signature.ts`_

  - [~] 5.2 Write property test for webhook signature round-trip (Property 1)
    - **Property 1: Webhook Signature Round-Trip**
    - For any arbitrary payload and secret, verify that sign then verify returns true; for mismatched secrets, verify returns false
    - **Validates: Requirements 3.1, 3.2, 14.5, 17.1**
    - _Validation: `npx vitest run <test-file>` passes all property tests; tests generate at least 100 random inputs_

  - [~] 5.3 Write property test for replay attack rejection (Property 2)
    - **Property 2: Replay Attack Rejection**
    - For any webhook with timestamp > 5 minutes from now, verify rejection regardless of signature validity
    - **Validates: Requirement 3.3**
    - _Validation: `npx vitest run <test-file>` passes all property tests; tests generate at least 100 random inputs_

  - [~] 5.4 Implement Webhook Receiver Lambda handler
    - Create `packages/webhook-receiver/src/handler.ts` with API Gateway proxy event handler
    - Validate Standard Webhooks signature using the signature library
    - Extract `X-MCP-Subscription-Id` header
    - Enqueue validated event to SQS with `subscriptionId` as message attribute
    - Return 200 on success, 401 on invalid signature, 400 on missing headers
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 19.2_
    - _Validation: `npx tsc --noEmit` compiles without errors; `npx vitest run` passes unit tests for the handler; `npx eslint packages/webhook-receiver/src/handler.ts`_

- [ ] 6. MCP Server 1 — USGS Earthquake Feed
  - [~] 6.1 Implement USGS feed polling and cursor-based deduplication
    - Create `packages/usgs-server/src/poller.ts` with USGS GeoJSON fetch, earthquake extraction, and cursor comparison logic
    - Read cursor state from DynamoDB, compare earthquake IDs against `lastSeenIds`
    - Update cursor atomically after successful emission
    - Bound `lastSeenIds` to 200 entries (rolling window)
    - _Requirements: 1.1, 1.4, 1.6_
    - _Validation: `npx tsc --noEmit` compiles without errors; `npx vitest run` passes unit tests for the handler; `npx eslint packages/usgs-server/src/poller.ts`_

  - [~] 6.2 Write property test for earthquake deduplication (Property 3)
    - **Property 3: Earthquake Deduplication (Cursor Integrity)**
    - Generate arbitrary sequences of poll results with overlapping IDs, verify each earthquake emitted at most once per subscription
    - **Validates: Requirements 1.1, 1.4, 1.6**
    - _Validation: `npx vitest run <test-file>` passes all property tests; tests generate at least 100 random inputs_

  - [~] 6.3 Implement per-subscription earthquake filtering
    - Create `packages/usgs-server/src/filter.ts` with filter logic: magnitude >= minMagnitude, region match, depth <= maxDepthKm
    - When no filter params set, deliver all earthquakes
    - Iterate over all active subscriptions for each new earthquake
    - _Requirements: 1.2, 1.5, 12.1, 12.2, 12.3, 12.4_
    - _Validation: `npx tsc --noEmit` compiles without errors; `npx vitest run` passes unit tests for the handler; `npx eslint packages/usgs-server/src/filter.ts`_

  - [~] 6.4 Write property test for per-customer earthquake filtering (Property 4)
    - **Property 4: Per-Customer Earthquake Filtering**
    - Generate arbitrary earthquakes and subscription filter params, verify delivery decision matches filter criteria exactly
    - **Validates: Requirements 1.2, 1.5, 12.1, 12.2, 12.3, 12.4**
    - _Validation: `npx vitest run <test-file>` passes all property tests; tests generate at least 100 random inputs_

  - [~] 6.5 Implement MCP Server 1 Lambda handler with webhook delivery
    - Create `packages/usgs-server/src/handler.ts` with dual-trigger handler (EventBridge for polling, API Gateway for MCP protocol)
    - Implement `events/list`, `events/subscribe`, `events/unsubscribe` MCP methods
    - Deliver filtered earthquakes via HTTP POST with Standard Webhooks signatures and `X-MCP-Subscription-Id` header
    - Implement retry with exponential backoff (3 attempts: 1s/5s/30s)
    - Manage subscription lifecycle (create, refresh, expire) in DynamoDB
    - _Requirements: 1.3, 14.1, 14.3, 14.4, 14.5, 15.1_
    - _Validation: `npx tsc --noEmit` compiles without errors; `npx vitest run` passes unit tests for the handler; `npx eslint packages/usgs-server/src/handler.ts`_

- [ ] 7. MCP Server 2 — Message Scheduler
  - [~] 7.1 Implement cron schedule evaluation
    - Create `packages/scheduler-server/src/scheduler.ts` with cron expression parsing and evaluation against current time
    - Iterate over all active subscriptions, check which customers are due for briefing
    - _Requirements: 2.1, 2.3_
    - _Validation: `npx tsc --noEmit` compiles without errors; `npx vitest run` passes unit tests for the handler; `npx eslint packages/scheduler-server/src/scheduler.ts`_

  - [~] 7.2 Write property test for cron schedule evaluation (Property 13)
    - **Property 13: Cron Schedule Evaluation**
    - Generate arbitrary timestamps and cron expressions, verify trigger fires if and only if cron matches current time
    - **Validates: Requirements 2.1, 2.3**
    - _Validation: `npx vitest run <test-file>` passes all property tests; tests generate at least 100 random inputs_

  - [~] 7.3 Implement MCP Server 2 Lambda handler with webhook delivery
    - Create `packages/scheduler-server/src/handler.ts` with dual-trigger handler (EventBridge for schedule check, API Gateway for MCP protocol + manual trigger)
    - Implement `events/list`, `events/subscribe`, `events/unsubscribe` MCP methods
    - Implement manual trigger endpoint (`POST /trigger-briefing/:customerId`)
    - Deliver `briefing.trigger` events via HTTP POST with Standard Webhooks signatures and `X-MCP-Subscription-Id` header
    - _Requirements: 2.2, 2.4, 14.2, 14.3, 14.4, 14.5_
    - _Validation: `npx tsc --noEmit` compiles without errors; `npx vitest run` passes unit tests for the handler; `npx eslint packages/scheduler-server/src/handler.ts`_

  - [~] 7.4 Write property test for subscription creation response validity (Property 14)
    - **Property 14: Subscription Creation Response Validity**
    - For any valid events/subscribe request, verify response contains valid UUID subscriptionId and expiresAt in the future
    - **Validates: Requirement 14.3**
    - _Validation: `npx vitest run <test-file>` passes all property tests; tests generate at least 100 random inputs_

- [~] 8. Checkpoint — Verify MCP servers and webhook receiver
  - Ensure all tests pass, ask the user if questions arise.
  - _Validation: All preceding tasks' validations pass; `npx tsc --noEmit` compiles entire monorepo; `npx vitest run` passes all tests_

- [ ] 9. Serverless Agent
  - [~] 9.1 Configure distributed lock using @deliveryhero/dynamodb-lock
    - Create `packages/agent/src/lock.ts` that instantiates `DynamoDBLock` from `@deliveryhero/dynamodb-lock` with the session locks table name and DynamoDB client
    - Configure TTL of 60 seconds and acquisition timeout of 10 seconds
    - Export a helper function `withLock(customerId, fn)` that acquires the lock, runs the function, and releases in a finally block
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_
    - _Validation: `npx tsc --noEmit` compiles without errors; `npx vitest run` passes unit tests verifying lock helper wraps the library correctly; `npx eslint packages/agent/src/lock.ts`_

  - [~] 9.2 Write integration test for distributed lock behavior (Property 8)
    - **Property 8: Session Write Serialization (Mutual Exclusion)**
    - Test that two concurrent `withLock` calls for the same customer ID result in one waiting for the other (not both executing simultaneously)
    - Test that a lock with expired TTL can be acquired by a new caller
    - Use mocked DynamoDB client to simulate contention scenarios
    - **Validates: Requirements 6.1, 6.2, 6.4, 6.5**
    - _Validation: `npx vitest run <test-file>` passes all tests_

  - [~] 9.3 Implement event routing and customer resolution
    - Create `packages/agent/src/router.ts` with SQS message parsing, subscriptionId extraction from message attributes, and customer resolution via Data API (IAM SigV4 signed HTTP call)
    - Implement event type determination (earthquake.detected vs briefing.trigger)
    - Handle missing subscription-to-customer mapping (send to DLQ)
    - _Requirements: 4.1, 15.6_
    - _Validation: `npx tsc --noEmit` compiles without errors; `npx vitest run` passes unit tests for the handler; `npx eslint packages/agent/src/router.ts`_

  - [~] 9.4 Implement earthquake event processing logic
    - Create `packages/agent/src/accumulate.ts` with earthquake event processing
    - Inject earthquake data as a user message into the agent's conversation history
    - Invoke the LLM with the updated conversation (earthquake message + prior context); LLM responds with analysis
    - Implement idempotency check: skip if `eventId` already in session metadata
    - Persist updated conversation history (user message + assistant response) to S3 via Strands SDK SessionManager with S3Storage
    - _Requirements: 4.4, 7.1, 7.2_
    - _Validation: `npx tsc --noEmit` compiles without errors; `npx vitest run` passes unit tests for the handler; `npx eslint packages/agent/src/accumulate.ts`_

  - [~] 9.6 Write property test for idempotent event processing (Property 6)
    - **Property 6: Idempotent Event Processing**
    - Process the same event twice for the same customer, verify session state is identical after both processings; no duplicate earthquakes or reports
    - **Validates: Requirements 7.1, 7.2, 7.3**
    - _Validation: `npx vitest run <test-file>` passes all property tests; tests generate at least 100 random inputs_

  - [~] 9.7 Write property test for customer isolation (Property 7)
    - **Property 7: Customer Isolation**
    - Generate events with mixed customer IDs, verify each customer's session contains only their events and no cross-customer data leakage
    - **Validates: Requirements 5.1, 5.2**
    - _Validation: `npx vitest run <test-file>` passes all property tests; tests generate at least 100 random inputs_

  - [~] 9.8 Implement briefing generation logic
    - Create `packages/agent/src/briefing.ts` with briefing trigger processing
    - Load customer's `briefingPrompt` from config (used as system prompt)
    - Inject briefing trigger message into conversation history (e.g., "Generate your periodic briefing report now.")
    - Invoke the LLM with full conversation history (which already contains all earthquake observations as prior messages); LLM synthesizes everything in context and calls the `save_report` tool
    - The `save_report` tool callback writes the report to S3 via the Data API
    - Persist updated session to S3 (conversation cleared or retained based on context window management)
    - _Requirements: 4.5, 4.6, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_
    - _Validation: `npx tsc --noEmit` compiles without errors; `npx vitest run` passes unit tests for the handler; `npx eslint packages/agent/src/briefing.ts`_

  - [~] 9.9 Write property test for briefing report completeness (Property 9)
    - **Property 9: Briefing Report Completeness and Integrity**
    - Generate arbitrary sequences of earthquake user messages in conversation history, verify that when the LLM generates a briefing it has access to all prior earthquake messages in the conversation; verify periodStart < periodEnd and notableQuakes reference earthquakes present in the conversation context
    - **Validates: Requirements 11.1, 11.3, 11.5, 11.6**
    - _Validation: `npx vitest run <test-file>` passes all property tests; tests generate at least 100 random inputs_

  - [~] 9.10 Implement Agent Lambda handler with SQS integration
    - Create `packages/agent/src/handler.ts` with SQS event handler (batch size 1)
    - Wire together: parse SQS message → resolve customer → acquire lock → restore session → inject event as message → invoke LLM → if briefing trigger, LLM calls `save_report` tool → persist session → release lock
    - Implement partial batch failure response (SQSBatchResponse)
    - Handle lock timeout (throw error for SQS retry)
    - Handle corrupted session (start fresh, archive corrupted)
    - _Requirements: 4.1, 4.2, 4.3, 4.7, 6.3, 15.2, 15.5_
    - _Validation: `npx tsc --noEmit` compiles without errors; `npx vitest run` passes unit tests for the handler; `npx eslint packages/agent/src/handler.ts`_

- [ ] 10. Subscription Manager
  - [~] 10.1 Implement subscription creation for new customers
    - Create `packages/subscription-manager/src/register.ts` with customer registration logic
    - Parse DynamoDB Stream INSERT events to detect new customers
    - Call MCP Server 1 `events/subscribe` with customer's filter params via StreamableHTTPClientWithSigV4Transport
    - Call MCP Server 2 `events/subscribe` with customer's cron schedule
    - Store WebhookSubscription records via Data API
    - Handle partial failures (one server succeeds, other fails) with retry
    - _Requirements: 8.1, 8.3, 14.6_
    - _Validation: `npx tsc --noEmit` compiles without errors; `npx vitest run` passes unit tests for the handler; `npx eslint packages/subscription-manager/src/register.ts`_

  - [~] 10.2 Implement subscription refresh logic
    - Create `packages/subscription-manager/src/refresh.ts` with scheduled refresh logic
    - Query Data API for all active customers and their subscriptions
    - Identify subscriptions expiring within threshold period
    - Refresh via MCP `events/subscribe` on appropriate server
    - Update subscription records with new `expiresAt` and `lastRefreshedAt`
    - Detect and re-create missing subscriptions for active customers
    - Log failures at per-customer granularity
    - _Requirements: 8.2, 8.4, 8.5, 15.3_
    - _Validation: `npx tsc --noEmit` compiles without errors; `npx vitest run` passes unit tests for the handler; `npx eslint packages/subscription-manager/src/refresh.ts`_

  - [~] 10.3 Write property test for subscription expiry detection (Property 10)
    - **Property 10: Subscription Expiry Detection and Refresh**
    - Generate arbitrary sets of subscriptions with various expiry times, verify all expiring within threshold are identified; verify missing subscriptions for active customers are detected
    - **Validates: Requirements 8.2, 8.5, 15.3**
    - _Validation: `npx vitest run <test-file>` passes all property tests; tests generate at least 100 random inputs_

  - [~] 10.4 Implement Subscription Manager Lambda handler
    - Create `packages/subscription-manager/src/handler.ts` with dual-trigger handler (DynamoDB Stream + EventBridge)
    - Detect trigger source and route to registration or refresh logic
    - Wire MCP client connections using `@aws/run-mcp-servers-with-aws-lambda` StreamableHTTPClientWithSigV4Transport
    - _Requirements: 8.1, 8.2, 14.6_
    - _Validation: `npx tsc --noEmit` compiles without errors; `npx vitest run` passes unit tests for the handler; `npx eslint packages/subscription-manager/src/handler.ts`_

- [~] 11. Checkpoint — Verify agent and subscription manager
  - Ensure all tests pass, ask the user if questions arise.
  - _Validation: All preceding tasks' validations pass; `npx tsc --noEmit` compiles entire monorepo; `npx vitest run` passes all tests_

- [ ] 12. Webapp (SvelteKit SPA)
  - [~] 12.1 Initialize SvelteKit project with shadcn-svelte
    - Create `packages/webapp` with SvelteKit (static adapter for S3/CloudFront deployment)
    - Install and configure shadcn-svelte, Tailwind CSS
    - Configure SvelteKit for SPA mode with static adapter
    - _Requirements: 10.1_
    - _Validation: `npm run build` succeeds (SvelteKit static build); `npm run check` passes (svelte-check for type errors); visual inspection: `npm run dev` and verify UI renders correctly_

  - [~] 12.2 Implement Cognito authentication flow
    - Create auth module with Cognito Hosted UI redirect flow (authorization code + PKCE)
    - Store JWT tokens in memory only (not localStorage)
    - Derive `customerId` from JWT `sub` claim
    - Implement sign-up, sign-in, sign-out, and token refresh
    - _Requirements: 10.1, 10.2, 10.6_
    - _Validation: `npm run build` succeeds (SvelteKit static build); `npm run check` passes (svelte-check for type errors); visual inspection: `npm run dev` and verify UI renders correctly_

  - [~] 12.3 Implement subscription configuration page
    - Create subscription config form with shadcn-svelte components (Input, Select, Button, Card)
    - Fields: displayName, minMagnitude (number input), region (select), maxDepthKm (number input), briefingPrompt (textarea), briefingSchedule (cron input)
    - Call `PUT /customers/:customerId/config` on submit with Bearer JWT
    - _Requirements: 10.3_
    - _Validation: `npm run build` succeeds (SvelteKit static build); `npm run check` passes (svelte-check for type errors); visual inspection: `npm run dev` and verify UI renders correctly_

  - [~] 12.4 Implement reports view and manual trigger
    - Create reports list page calling `GET /customers/:customerId/reports`
    - Create report detail view calling `GET /customers/:customerId/reports/:reportId`
    - Add "Trigger Briefing Now" button calling `POST /trigger-briefing/:customerId`
    - Display report summary, notable quakes, geographic patterns, comparison
    - _Requirements: 10.4, 10.5_
    - _Validation: `npm run build` succeeds (SvelteKit static build); `npm run check` passes (svelte-check for type errors); visual inspection: `npm run dev` and verify UI renders correctly_

  - [~] 12.5 Implement conversation history view
    - Create conversation history page/section calling `GET /customers/:customerId/session/messages` with Cognito JWT
    - Render messages as a chat-style timeline with distinct visual treatments per message role:
      - User messages (earthquake event injections) displayed as event cards showing earthquake data
      - Assistant messages (LLM analysis) displayed as agent response bubbles
      - Tool use messages (save_report calls) displayed as action cards showing report generation
      - Tool result messages displayed as confirmation badges
    - Implement auto-refresh polling every 30 seconds so users can watch events arrive in real-time during a demo
    - Handle empty state (no messages yet) with appropriate placeholder
    - _Requirements: 10.7_
    - _Validation: `npm run build` succeeds (SvelteKit static build); `npm run check` passes (svelte-check for type errors); visual inspection: `npm run dev` and verify UI renders correctly_

- [ ] 13. Integration wiring and end-to-end testing
  - [~] 13.1 Wire all CDK stacks with cross-stack references
    - Ensure all CfnOutput exports and Fn.importValue imports are correctly wired
    - Verify IAM roles have correct permissions (least-privilege)
    - Verify environment variables pass correct URLs and ARNs to all Lambdas
    - Run `cdk synth` and verify no circular dependencies
    - _Requirements: 13.5, 17.3_
    - _Validation: `npx cdk synth` succeeds for all stacks with no circular dependency errors; `npx tsc --noEmit` compiles across entire monorepo_

  - [~] 13.2 Write integration tests for end-to-end event flow
    - Test customer registration flow: create config → verify subscriptions created on both servers
    - Test earthquake event flow: POST simulated earthquake → verify accumulation in correct customer session
    - Test briefing trigger flow: trigger briefing → verify report written to S3
    - Test customer isolation: events for customer A don't appear in customer B's session
    - Test subscription refresh: verify expiring subscriptions are refreshed
    - Test DLQ behavior on simulated failures
    - _Requirements: 4.1, 4.4, 4.5, 5.1, 5.2, 8.1, 8.2, 15.2_
    - _Validation: `npx vitest run packages/integration-tests` passes all tests against deployed stack_

- [~] 14. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
  - _Validation: All preceding tasks' validations pass; `npx tsc --noEmit` compiles entire monorepo; `npx vitest run` passes all tests_

## Notes

- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- TypeScript is used throughout (as specified in the design document)
- The monorepo workspace structure enables parallel development of independent packages
- CDK stacks are defined early to establish the infrastructure contract that Lambda handlers implement against

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3", "2.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "2.4"] },
    { "id": 4, "tasks": ["2.5"] },
    { "id": 5, "tasks": ["4.1", "5.1", "6.1", "7.1"] },
    {
      "id": 6,
      "tasks": ["4.2", "4.3", "5.2", "5.3", "5.4", "6.2", "6.3", "7.2", "7.3"]
    },
    { "id": 7, "tasks": ["4.4", "4.5", "4.6", "6.4", "6.5", "7.4", "9.1"] },
    { "id": 8, "tasks": ["9.2", "9.3"] },
    { "id": 9, "tasks": ["9.4", "9.8"] },
    { "id": 10, "tasks": ["9.6", "9.7", "9.9", "9.10"] },
    { "id": 11, "tasks": ["10.1", "10.2"] },
    { "id": 12, "tasks": ["10.3", "10.4", "12.1"] },
    { "id": 13, "tasks": ["12.2"] },
    { "id": 14, "tasks": ["12.3", "12.4", "12.5"] },
    { "id": 15, "tasks": ["13.1"] },
    { "id": 16, "tasks": ["13.2"] }
  ]
}
```
