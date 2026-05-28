# Requirements Document

## Introduction

This document defines the requirements for the MCP Events Serverless Agent — an earthquake monitoring system that demonstrates the experimental MCP Events extension using webhook delivery mode. The system supports multiple customers, each with independent agent sessions, tailored subscription parameters, and custom briefing prompts. Two MCP servers (USGS Earthquake Feed and Message Scheduler) deliver events via webhooks to a serverless Strands Agent that accumulates earthquake data and generates tailored briefing reports per customer.

## Glossary

- **MCP_Server_1**: The USGS Earthquake Feed Lambda that polls the USGS API, detects new earthquakes, and delivers filtered events via webhook to subscribers
- **MCP_Server_2**: The Message Scheduler Lambda that emits time-based briefing trigger events per customer on their configured cron schedule
- **Webhook_Receiver**: The API Gateway + SQS component that validates Standard Webhooks signatures and buffers events for processing
- **Serverless_Agent**: The Strands Agent Lambda that processes MCP events, accumulates earthquakes per customer, and generates briefing reports
- **Subscription_Manager**: The Lambda that creates and refreshes per-customer webhook subscriptions on both MCP servers
- **Data_API**: The shared API Gateway + Lambda persistence layer for customer config, subscriptions, and reports
- **Webapp**: The SvelteKit SPA frontend for customer self-service configuration and report viewing
- **Customer**: An authenticated user with their own subscription parameters, briefing prompt, and isolated session
- **Session**: Per-customer agent state stored in S3 containing accumulated earthquakes and conversation history
- **Subscription**: A webhook subscription record linking a customer to an MCP server event type with filter parameters
- **Briefing_Report**: An LLM-generated summary of accumulated earthquake activity for a specific customer
- **Standard_Webhooks**: The HMAC-SHA256 signature scheme used to authenticate webhook deliveries
- **Distributed_Lock**: A DynamoDB-based pessimistic lock ensuring serialized session writes per customer

## Requirements

### Requirement 1: USGS Earthquake Polling and Event Emission

**User Story:** As a system operator, I want MCP Server 1 to poll the USGS earthquake API and emit new earthquakes as MCP events, so that customers receive near-real-time earthquake notifications matching their filters.

#### Acceptance Criteria

1. WHEN the EventBridge schedule triggers MCP_Server_1, THE MCP_Server_1 SHALL poll the USGS 2.5-magnitude-day GeoJSON feed and detect new earthquakes using cursor-based deduplication
2. WHEN new earthquakes are detected, THE MCP_Server_1 SHALL iterate over all active webhook subscriptions and apply per-subscription filter parameters (minMagnitude, region, maxDepthKm)
3. WHEN an earthquake matches a subscription's filter parameters, THE MCP_Server_1 SHALL deliver an `earthquake.detected` event via HTTP POST with Standard Webhooks HMAC-SHA256 signature and `X-MCP-Subscription-Id` header
4. THE MCP_Server_1 SHALL update the cursor state in DynamoDB atomically after successful event emission to prevent duplicate emissions
5. WHEN an earthquake does not match a subscription's filter parameters, THE MCP_Server_1 SHALL skip delivery for that subscription without affecting other subscriptions
6. THE MCP_Server_1 SHALL emit each earthquake at most once per subscription across all poll cycles

### Requirement 2: Briefing Schedule and Trigger Delivery

**User Story:** As a customer, I want to receive briefing triggers on my configured schedule, so that I get periodic earthquake summaries tailored to my needs.

#### Acceptance Criteria

1. WHEN the EventBridge schedule triggers MCP_Server_2 every minute, THE MCP_Server_2 SHALL evaluate each active subscription's cron schedule against the current time
2. WHEN a customer's cron schedule matches the current time, THE MCP_Server_2 SHALL deliver a `briefing.trigger` event via webhook with Standard Webhooks signature and `X-MCP-Subscription-Id` header
3. WHEN a customer's cron schedule does not match the current time, THE MCP_Server_2 SHALL skip that customer without affecting other customers
4. WHEN a manual trigger request is received for a specific customer, THE MCP_Server_2 SHALL deliver a `briefing.trigger` event immediately for that customer regardless of schedule

### Requirement 3: Webhook Validation and Event Buffering

**User Story:** As a system operator, I want incoming webhooks to be validated and buffered reliably, so that only authentic events are processed and no events are lost.

#### Acceptance Criteria

1. WHEN a webhook delivery is received, THE Webhook_Receiver SHALL validate the Standard Webhooks HMAC-SHA256 signature against the known server secrets
2. IF the webhook signature is invalid, THEN THE Webhook_Receiver SHALL return HTTP 401 and discard the event
3. IF the webhook timestamp exceeds the 5-minute tolerance window, THEN THE Webhook_Receiver SHALL reject the delivery as a potential replay attack
4. WHEN a webhook delivery passes validation, THE Webhook_Receiver SHALL enqueue the event to SQS with the `subscriptionId` extracted from the `X-MCP-Subscription-Id` header as a message attribute
5. THE Webhook_Receiver SHALL return HTTP 200 within 100 milliseconds to avoid webhook timeout and retry from the MCP servers

### Requirement 4: Event Processing and Customer Routing

**User Story:** As a customer, I want my earthquake events to be routed to my isolated session, so that my data remains separate from other customers.

#### Acceptance Criteria

1. WHEN the Serverless_Agent is triggered by an SQS message, THE Serverless_Agent SHALL extract the `subscriptionId` from message attributes and resolve it to a `customerId` via the Data_API
2. WHEN the customer is resolved, THE Serverless_Agent SHALL acquire a distributed lock on the customer ID before reading session state
3. WHEN the lock is acquired, THE Serverless_Agent SHALL restore the customer's session from S3 using the Strands SDK SessionManager with S3Storage at path `sessions/{customerId}/session.json`
4. WHEN an `earthquake.detected` event is processed, THE Serverless_Agent SHALL add the earthquake to the customer's `accumulatedEarthquakes` in session state and persist the updated session to S3
5. WHEN a `briefing.trigger` event is processed, THE Serverless_Agent SHALL synthesize accumulated earthquakes into a briefing report using the customer's `briefingPrompt` and an LLM
6. WHEN a briefing report is generated, THE Serverless_Agent SHALL write the report via the Data_API, clear the customer's `accumulatedEarthquakes`, and persist the updated session to S3
7. THE Serverless_Agent SHALL release the distributed lock after session state is persisted

### Requirement 5: Customer Isolation

**User Story:** As a customer, I want my earthquake data and reports to be completely isolated from other customers, so that my information remains private and accurate.

#### Acceptance Criteria

1. THE Serverless_Agent SHALL only read and write the session file belonging to the customer resolved from the subscription lookup during any single invocation
2. THE Serverless_Agent SHALL never include earthquakes from one customer's session in another customer's briefing report
3. WHEN the Data_API receives a Cognito-authorized request, THE Data_API SHALL validate that the `customerId` in the URL path matches the JWT `sub` claim and reject with HTTP 403 on mismatch
4. THE Data_API SHALL store reports at S3 path `reports/{customerId}/` ensuring path-based isolation between customers

### Requirement 6: Session Write Serialization

**User Story:** As a system operator, I want concurrent events for the same customer to be serialized, so that session state is never corrupted by lost updates.

#### Acceptance Criteria

1. THE Serverless_Agent SHALL acquire a distributed lock on the customer ID before reading or writing session state
2. WHILE a lock is held for a customer, THE Serverless_Agent SHALL prevent any other invocation from acquiring the same lock
3. IF the lock cannot be acquired within the timeout period (10 seconds), THEN THE Serverless_Agent SHALL throw an error causing the SQS message to return to the queue for retry
4. THE Distributed_Lock SHALL use a TTL of 60 seconds to auto-release locks from crashed invocations
5. THE Distributed_Lock SHALL use conditional writes ensuring only the lock owner can release the lock

### Requirement 7: Idempotent Event Processing

**User Story:** As a system operator, I want duplicate event deliveries to be handled safely, so that SQS at-least-once delivery does not corrupt customer data.

#### Acceptance Criteria

1. WHEN the Serverless_Agent receives an event with an `eventId` already present in the customer's session metadata, THE Serverless_Agent SHALL skip processing and return success
2. THE Serverless_Agent SHALL not add the same earthquake twice to a customer's `accumulatedEarthquakes` even if the same event is delivered multiple times
3. WHEN a duplicate `briefing.trigger` event is received after a briefing was already generated, THE Serverless_Agent SHALL not generate an empty report

### Requirement 8: Subscription Lifecycle Management

**User Story:** As a customer, I want my webhook subscriptions to be automatically created and maintained, so that I receive events without manual intervention.

#### Acceptance Criteria

1. WHEN a new CustomerConfig record is inserted into DynamoDB, THE Subscription_Manager SHALL create webhook subscriptions on both MCP_Server_1 (with customer filter params) and MCP_Server_2 (with customer cron schedule)
2. WHEN the EventBridge schedule triggers the Subscription_Manager, THE Subscription_Manager SHALL refresh all subscriptions expiring within the threshold period
3. THE Subscription_Manager SHALL store subscription records via the Data_API with `subscriptionId`, `customerId`, `expiresAt`, and server-specific parameters
4. WHEN a subscription refresh fails, THE Subscription_Manager SHALL log the failure at per-customer granularity and retry on the next scheduled run
5. THE Subscription_Manager SHALL detect and re-create missing subscriptions for active customers during scheduled refresh runs

### Requirement 9: Data API Persistence and Authorization

**User Story:** As a developer, I want a shared Data API that handles persistence for config, subscriptions, and reports with proper authorization, so that both the webapp and agent can access data securely.

#### Acceptance Criteria

1. THE Data_API SHALL support dual authorization: Cognito User Pool Authorizer for webapp requests and IAM Authorizer for Serverless_Agent requests
2. WHEN a Cognito-authorized request targets a customer resource, THE Data_API SHALL validate that the JWT `sub` claim matches the `customerId` in the URL path
3. WHEN an IAM-authorized request is received, THE Data_API SHALL allow access to any customer's data (restricted to the Serverless_Agent's execution role via resource policy)
4. THE Data_API SHALL validate all request bodies against zod schemas and return HTTP 400 for malformed requests
5. THE Data_API SHALL provide CRUD operations for CustomerConfig stored in DynamoDB
6. THE Data_API SHALL provide read and write operations for BriefingReports stored in S3 at `reports/{customerId}/{reportId}.json`
7. THE Data_API SHALL provide subscription lookup by `subscriptionId` returning the associated `customerId` for event routing

### Requirement 10: Customer Self-Service Webapp

**User Story:** As a customer, I want a web application where I can configure my earthquake monitoring subscription, view reports, and trigger briefings manually, so that I can manage my monitoring independently.

#### Acceptance Criteria

1. THE Webapp SHALL authenticate users via Amazon Cognito Hosted UI with sign-up, sign-in, and password reset flows
2. WHEN a user is authenticated, THE Webapp SHALL derive the `customerId` from the Cognito JWT `sub` claim for all API calls
3. THE Webapp SHALL provide a form for configuring subscription parameters (minMagnitude, region, maxDepthKm), briefing prompt, and briefing schedule
4. THE Webapp SHALL display a list of generated briefing reports with the ability to view full report content
5. THE Webapp SHALL provide a manual trigger button that invokes `POST /trigger-briefing/:customerId` to generate an immediate briefing
6. THE Webapp SHALL store JWT tokens in memory only (not localStorage) to mitigate XSS token theft

### Requirement 11: Briefing Report Generation

**User Story:** As a customer, I want my briefing reports to include all accumulated earthquakes since my last briefing with analysis tailored to my prompt, so that I receive comprehensive and personalized seismic summaries.

#### Acceptance Criteria

1. WHEN a briefing is generated, THE Serverless_Agent SHALL include all earthquakes accumulated in the customer's session since the last briefing
2. THE Serverless_Agent SHALL use the customer's `briefingPrompt` as the system prompt for LLM-based report synthesis
3. THE Briefing_Report SHALL contain a summary, notable quakes, geographic patterns, comparison to previous period, and the raw earthquake data
4. WHEN a previous briefing exists for the customer, THE Serverless_Agent SHALL retrieve it via the Data_API for comparison analysis
5. THE Briefing_Report SHALL record `periodStart` and `periodEnd` timestamps bounding the reporting period
6. THE Briefing_Report SHALL have `totalEarthquakes` equal to the count of earthquakes in `rawData`

### Requirement 12: Per-Customer Earthquake Filtering

**User Story:** As a customer, I want earthquakes filtered according to my configured parameters, so that I only receive notifications relevant to my monitoring needs.

#### Acceptance Criteria

1. WHEN evaluating an earthquake against a subscription, THE MCP_Server_1 SHALL deliver the earthquake only if its magnitude is greater than or equal to the subscription's `minMagnitude` parameter
2. WHERE a subscription specifies a `region` filter, THE MCP_Server_1 SHALL deliver only earthquakes located within that geographic region
3. WHERE a subscription specifies a `maxDepthKm` filter, THE MCP_Server_1 SHALL deliver only earthquakes with depth less than or equal to the specified maximum
4. WHEN a subscription has no filter parameters set, THE MCP_Server_1 SHALL deliver all earthquakes from the USGS feed to that subscription

### Requirement 13: CDK Infrastructure Deployment

**User Story:** As a developer, I want the entire system deployed via a single `cdk deploy --all` command with custom domains, so that the multi-stack architecture is reproducible and manageable.

#### Acceptance Criteria

1. THE CDK application SHALL synthesize multiple stacks (Auth, DataApi, UsgsServer, SchedulerServer, WebhookReceiver, Agent, SubscriptionManager, Webapp) from a single CDK app
2. THE CDK application SHALL create a Route53 subdomain zone `earthquake-agent.<parentDomain>` with NS delegation from the parent zone
3. THE CDK application SHALL provision an ACM wildcard certificate for `*.earthquake-agent.<parentDomain>` with DNS validation
4. WHEN deployed, each stack with a public endpoint SHALL have a custom domain under `earthquake-agent.<parentDomain>`
5. THE CDK application SHALL use cross-stack references via CfnOutput and Fn.importValue for shared resource ARNs and URLs

### Requirement 14: MCP Protocol Compliance

**User Story:** As a developer, I want the system to comply with the MCP Events extension specification, so that it demonstrates correct usage of the experimental protocol.

#### Acceptance Criteria

1. THE MCP_Server_1 SHALL declare the `earthquake.detected` event type with an `inputSchema` accepting filter parameters via the `events/list` method
2. THE MCP_Server_2 SHALL declare the `briefing.trigger` event type with an `inputSchema` accepting a schedule parameter via the `events/list` method
3. WHEN an `events/subscribe` request is received, THE MCP servers SHALL create a subscription with the provided webhook URL, secret, and input parameters, returning a `subscriptionId` and `expiresAt`
4. WHEN delivering events via webhook, THE MCP servers SHALL include the `X-MCP-Subscription-Id` header identifying the target subscription
5. THE MCP servers SHALL use Standard Webhooks HMAC-SHA256 signatures for all webhook deliveries
6. THE Subscription_Manager SHALL use the MCP `events/subscribe` method via StreamableHTTPClientWithSigV4Transport to create and refresh subscriptions

### Requirement 15: Error Handling and Recovery

**User Story:** As a system operator, I want the system to handle failures gracefully with automatic recovery, so that transient errors do not cause data loss or permanent degradation.

#### Acceptance Criteria

1. IF a webhook delivery fails, THEN THE MCP servers SHALL retry with exponential backoff (3 attempts with 1s/5s/30s delays)
2. IF the Serverless_Agent fails during event processing, THEN the SQS message SHALL become visible again after the visibility timeout for retry (up to 3 attempts before moving to DLQ)
3. IF a subscription expires before refresh, THEN THE Subscription_Manager SHALL detect and re-create the subscription on the next scheduled run
4. IF the USGS API is unavailable, THEN THE MCP_Server_1 SHALL exit without emitting events and retry on the next scheduled poll (cursor state unchanged)
5. IF session state is corrupted, THEN THE Serverless_Agent SHALL start with a fresh session for that customer and archive the corrupted session
6. IF the subscription-to-customer mapping cannot be resolved, THEN THE Serverless_Agent SHALL send the message to the DLQ for investigation

### Requirement 16: Data Validation

**User Story:** As a system operator, I want all data inputs validated against schemas, so that invalid data does not corrupt system state.

#### Acceptance Criteria

1. THE Data_API SHALL validate that `customerId` conforms to UUID v4 format
2. THE Data_API SHALL validate that `subscriptionParams.minMagnitude` is between 0 and 10 inclusive
3. THE Data_API SHALL validate that `subscriptionParams.region` is one of: "pacific", "americas", "europe", "asia", "africa", or undefined
4. THE Data_API SHALL validate that `briefingPrompt` is non-empty and does not exceed 2000 characters
5. THE Data_API SHALL validate that `briefingSchedule` is a valid cron expression
6. WHEN validation fails, THE Data_API SHALL return HTTP 400 with a descriptive error message

### Requirement 17: Security Controls

**User Story:** As a system operator, I want proper security controls across all components, so that the system is protected against unauthorized access and common attack vectors.

#### Acceptance Criteria

1. THE Webhook_Receiver SHALL validate Standard Webhooks HMAC-SHA256 signatures on all incoming webhook deliveries
2. THE Data_API SHALL enforce CORS allowing only the CloudFront distribution origin with credentials mode enabled
3. THE CDK application SHALL configure each Lambda with a dedicated IAM role following least-privilege principles
4. THE Webapp SHALL serve static assets from S3 via CloudFront with Origin Access Control (OAC) preventing direct S3 access
5. THE CDK application SHALL store webhook HMAC secrets in SSM Parameter Store as SecureString
6. THE MCP servers SHALL use IAM authorization on their API Gateway endpoints for server-to-server communication
7. THE Serverless_Agent SHALL sign Data_API requests with IAM SigV4 credentials

### Requirement 18: Observability and Monitoring

**User Story:** As a system operator, I want visibility into system health and failures, so that I can detect and respond to issues promptly.

#### Acceptance Criteria

1. WHEN a webhook delivery fails after all retries, THE MCP servers SHALL trigger a CloudWatch alarm for operator notification
2. WHEN messages accumulate in the DLQ, THE system SHALL trigger a CloudWatch alarm on DLQ depth
3. WHEN subscription refresh fails for a customer, THE Subscription_Manager SHALL log the failure with customer ID for alerting
4. THE system SHALL log all errors with sufficient context (customerId, subscriptionId, eventId) for debugging

### Requirement 19: Performance and Scalability

**User Story:** As a system operator, I want the system to handle expected load efficiently with zero idle compute cost, so that it remains cost-effective and responsive.

#### Acceptance Criteria

1. WHILE no events are being processed, THE system SHALL have zero running Lambda compute (zero idle cost)
2. THE Webhook_Receiver SHALL complete signature validation and SQS enqueue within 100 milliseconds
3. THE MCP_Server_1 SHALL support filtering earthquakes against up to 100 customer subscriptions per poll cycle
4. THE Serverless_Agent SHALL use SQS batch size of 1 to ensure each event gets full Lambda execution time
5. THE system SHALL use standard SQS (not FIFO) to enable concurrent processing of events for different customers
