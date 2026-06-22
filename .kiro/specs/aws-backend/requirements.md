# Requirements Document

## Introduction

This document specifies requirements for the **AWS backend** of the Alchemist Business OS ("1145 AI") platform — an AI voice-agent platform for small businesses (HVAC, dental, salons). A caller dials a business, an AI agent answers, books appointments, takes orders, captures leads, and escalates to a human when unsure. The owner/operator observes everything live from a dashboard.

This backend provides the reasoning, workflows, data, ML, and control plane behind that experience. It is a CDK serverless AWS platform. It receives caller utterances over the SE-1 boundary from a separate voice edge (Telnyx/LiveKit middleware) and pushes live call state to the dashboard over the CP-3 AppSync boundary.

**Scope boundary.** This spec covers ONLY the AWS backend. The following are explicitly out of scope and live in separate repos: the voice edge (Telnyx/LiveKit middleware), the frontend dashboard SPA, the investor portal (frontend Amplify), and the `@alchemist/contracts` package itself. The backend **imports** boundary contracts (SE-1 proto, AC-2 tool schema, CP-2 openapi.yaml, CP-3 graphql/schema.graphql); it never declares or re-authors them.

The platform serves two distinct audiences with separate identity pools that are never merged: **tenant/operator** (this platform, CP-1) and **investor portal** (frontend Amplify). This backend owns only the tenant/operator pool.

## Glossary

- **Backend**: The AWS serverless platform specified by this document (reasoning, workflows, data, ML, control plane).
- **Tenant**: A business customer of the platform. Identified by `tenantId`.
- **TenantId**: The unique identifier for a tenant, used as the DynamoDB partition key prefix `TENANT#<tenantId>`.
- **Operator**: A human owner/employee of a tenant business who uses the dashboard.
- **Cognito_User_Pool**: The CP-1 tenant/operator identity pool owned by this Backend, separate from the investor-portal pool.
- **Validated_Session**: A session whose identity (including `tenantId`) has been verified — either a Cognito session (CP-1) for dashboard/REST access or a validated SE-1 session for voice-edge input.
- **SE-1**: The imported contract boundary over which the voice edge sends caller utterances and session context to the Backend.
- **CP-1**: Cognito tenant/operator user pool.
- **CP-2**: API Gateway REST API implementing the contracts `openapi.yaml`. Carries user-facing commands.
- **CP-3**: The AppSync GraphQL API provisioned from the imported `@alchemist/contracts` `graphql/schema.graphql` SDL.
- **CP-4**: Per-tenant KMS encryption keys.
- **AppSync_Schema**: The GraphQL SDL imported from `@alchemist/contracts` `graphql/schema.graphql`.
- **Publish_Mutation**: An AppSync mutation (`publishCallUpdate`, `appendTranscript`, `publishLead`, `publishCallEscalated`) authorized with `@aws_iam`, implemented as a no-op fan-out resolver, invoked by the Backend to push live state to subscribers.
- **AC_Runtime**: The AC-1 AgentCore runtime that holds session and tenant context for a call.
- **Tool_Gateway**: The AC-2 component that invokes tools (routing to workflows) using the imported AC-2 tool schema.
- **Memory**: The AC-3 component that hydrates short-term (Redis) and long-term (pgvector) context, tenant-scoped.
- **Bedrock_Reasoner**: The AC-4 component using Amazon Bedrock LLM plus Guardrails for reasoning and safety, confidence-gated.
- **Workflow_Orchestrator**: The WF-1 Step Functions/EventBridge orchestration layer.
- **Booking_Service**: The WF-2 Lambda that books appointments.
- **Orders_Service**: The WF-3 Lambda that takes orders.
- **Notification_Service**: The WF-4/WF-5 components sending email (SES) and SMS (SNS/Pinpoint).
- **Profile_Store**: The DM-2 DynamoDB store of profiles and orders, partitioned by `PK = TENANT#<tenantId>`.
- **Short_Term_Store**: The DM-1 Redis store for short-term call memory.
- **Embedding_Store**: The DM-3 pgvector/OpenSearch store for embeddings.
- **Object_Lake**: The DM-4 S3 data lake holding recordings and documents.
- **Sentiment_Scorer**: The ML-2 component scoring caller sentiment, published onto `Call.sentiment`.
- **Stream_Ingest**: The ML-1 Kinesis ingest pipeline.
- **Model_Pipeline**: The ML-4 SageMaker train/eval/registry pipeline.
- **Model_Deployer**: The ML-5 component that promotes improved models to the AC_Runtime.
- **Telemetry**: The CW CloudWatch metrics and alarms layer.
- **Call**: A single caller interaction, the central live entity surfaced on the dashboard.
- **Lead**: A captured sales/service inquiry extracted from a non-booking conversation.
- **Escalation**: A one-way handoff of a Call to a human operator when the AI is not confident.

## Requirements

### Requirement 1: Tenant/Operator Identity (CP-1)

**User Story:** As a platform operator, I want a dedicated tenant/operator identity pool, so that operators authenticate securely and every request carries a trustworthy tenant identity.

#### Acceptance Criteria

1. THE Backend SHALL provision a Cognito_User_Pool dedicated to tenant/operator identities.
2. THE Backend SHALL keep the Cognito_User_Pool separate from the investor-portal pool and SHALL NOT merge the two pools.
3. WHEN an operator authenticates successfully, THE Cognito_User_Pool SHALL issue a session that carries the operator's `tenantId`.
4. WHEN the Backend derives a `tenantId` for an operator request, THE Backend SHALL obtain the `tenantId` from the Validated_Session and SHALL NOT obtain it from a client-supplied field alone.
5. IF a request presents no Validated_Session, THEN THE Backend SHALL reject the request with an authorization error.

### Requirement 2: REST Command API (CP-2)

**User Story:** As an operator using the dashboard, I want to issue commands through a REST API, so that I can drive user-facing actions like managing bookings and orders.

#### Acceptance Criteria

1. THE Backend SHALL expose an API Gateway REST API that conforms to the imported contracts `openapi.yaml`.
2. THE Backend SHALL NOT author or re-declare the `openapi.yaml` contract within this repository.
3. WHEN a CP-2 request is received, THE Backend SHALL authorize the request against the CP-1 Validated_Session.
4. WHEN an authorized CP-2 command requires fulfillment, THE Backend SHALL route the command to the Workflow_Orchestrator.
5. WHEN a CP-2 command is processed, THE Backend SHALL scope all data access to the `tenantId` from the Validated_Session.
6. IF a CP-2 request does not conform to the `openapi.yaml` contract, THEN THE Backend SHALL reject the request with a validation error.

### Requirement 3: Live State GraphQL API (CP-3)

**User Story:** As an operator watching the dashboard, I want live call state delivered over a GraphQL subscription API, so that I can observe calls, transcripts, leads, and escalations as they happen.

#### Acceptance Criteria

1. THE Backend SHALL provision the CP-3 AppSync API from the AppSync_Schema imported from `@alchemist/contracts` `graphql/schema.graphql`.
2. THE Backend SHALL NOT re-declare or hand-author the AppSync_Schema types within CDK.
3. THE Backend SHALL authorize CP-3 read and subscription operations with `@aws_cognito_user_pools`.
4. THE Backend SHALL authorize CP-3 Publish_Mutation operations with `@aws_iam`.
5. WHEN a CP-3 Query or Subscription resolver runs, THE resolver SHALL read DynamoDB scoped to `PK = TENANT#<tenantId>` derived from the Validated_Session.
6. WHEN a CP-3 subscription includes a tenant argument, THE resolver SHALL treat the argument as a filter and SHALL enforce the tenant boundary from the Validated_Session rather than from the argument.
7. WHEN a Publish_Mutation is invoked, THE resolver SHALL set the tenant from the validated SE-1 session and SHALL perform no persistent write other than fan-out to subscribers.
8. THE Backend SHALL NOT accept user-facing writes through CP-3; user-facing writes SHALL arrive on CP-2 REST.

### Requirement 4: Per-Tenant Encryption (CP-4)

**User Story:** As a security owner, I want each tenant's data encrypted under its own key, so that tenant data is cryptographically isolated.

#### Acceptance Criteria

1. THE Backend SHALL provision a dedicated KMS key per tenant (CP-4).
2. WHEN the Backend stores tenant data at rest, THE Backend SHALL encrypt the data using that tenant's CP-4 key.
3. THE Backend SHALL NOT use one tenant's CP-4 key to encrypt or decrypt another tenant's data.

### Requirement 5: Multi-Tenant Isolation (Cross-Cutting)

**User Story:** As a platform owner, I want strict multi-tenant isolation across all components, so that no tenant can ever read, cache, or observe another tenant's data.

#### Acceptance Criteria

1. THE Backend SHALL partition every persisted record with `PK = TENANT#<tenantId>`.
2. WHEN the Backend issues a data query, THE Backend SHALL include a tenant scope in the query.
3. IF a data operation is attempted without a tenant scope, THEN THE Backend SHALL reject the operation.
4. THE Backend SHALL derive the operative `tenantId` from a Validated_Session for every tenant-scoped operation.
5. THE Backend SHALL exclude data belonging to other tenants from any read result returned to a caller.
6. THE Backend SHALL exclude tenant-identifying data of one tenant from caches and logs accessible in another tenant's context.

### Requirement 6: AgentCore Runtime and Session Context (AC-1)

**User Story:** As a caller, I want the AI agent to maintain my call's session and tenant context, so that the conversation stays coherent for the full call.

#### Acceptance Criteria

1. WHEN a Call begins over SE-1, THE AC_Runtime SHALL establish a session that holds the `tenantId` from the validated SE-1 session for the duration of the Call.
2. WHILE a Call is active, THE AC_Runtime SHALL associate each turn with the established session and `tenantId`.
3. THE AC_Runtime SHALL derive the `tenantId` from the validated SE-1 session and SHALL NOT derive it from a client-supplied field alone.
4. WHEN a Call ends, THE AC_Runtime SHALL release the session context for that Call.

### Requirement 7: Tool Gateway and Workflow Invocation (AC-2)

**User Story:** As the AI agent, I want a tool gateway that invokes backend workflows through a defined tool schema, so that caller intents become concrete actions like bookings and orders.

#### Acceptance Criteria

1. THE Tool_Gateway SHALL invoke tools using the imported AC-2 tool schema from contracts.
2. THE Backend SHALL NOT author or re-declare the AC-2 tool schema within this repository.
3. WHEN the Bedrock_Reasoner selects a tool action, THE Tool_Gateway SHALL route the invocation to the Workflow_Orchestrator (WF-1).
4. WHEN the Tool_Gateway invokes a workflow, THE Tool_Gateway SHALL pass the `tenantId` from the session context.
5. IF a tool invocation does not conform to the AC-2 tool schema, THEN THE Tool_Gateway SHALL reject the invocation with a validation error.

### Requirement 8: Memory Hydration (AC-3)

**User Story:** As the AI agent, I want short-term and long-term memory hydrated for the current tenant, so that I can reason with relevant context without leaking other tenants' data.

#### Acceptance Criteria

1. WHEN a turn requires context, THE Memory SHALL hydrate short-term context from the Short_Term_Store (Redis).
2. WHEN a turn requires long-term context, THE Memory SHALL hydrate long-term context from the Embedding_Store (pgvector).
3. THE Memory SHALL scope all hydration reads to the `tenantId` from the session context.
4. THE Memory SHALL exclude any context belonging to other tenants from hydrated results.

### Requirement 9: Bedrock Reasoning and Guardrails (AC-4)

**User Story:** As a business owner, I want the AI to reason safely and escalate when unsure, so that callers get accurate help and risky situations reach a human.

#### Acceptance Criteria

1. WHEN the AC_Runtime processes a caller turn, THE Bedrock_Reasoner SHALL generate a response using the Bedrock LLM with Guardrails applied.
2. WHILE the Bedrock_Reasoner's confidence for an action is below the configured threshold, THE Bedrock_Reasoner SHALL escalate rather than produce a guessed action.
3. IF Guardrails block a candidate response, THEN THE Bedrock_Reasoner SHALL withhold the blocked response and escalate.
4. THE Bedrock_Reasoner SHALL scope reasoning inputs to the current session's `tenantId`.

### Requirement 10: Live Call State Publication (AC turn updates → CP-3)

**User Story:** As an operator, I want each call turn reflected on the dashboard in near real time, so that I can monitor active calls.

#### Acceptance Criteria

1. WHEN the AC_Runtime completes processing of a caller turn, THE Backend SHALL invoke the CP-3 `publishCallUpdate` Publish_Mutation with the updated Call state.
2. WHEN a caller or agent utterance is finalized for a turn, THE Backend SHALL invoke the CP-3 `appendTranscript` Publish_Mutation with the transcript segment.
3. WHEN the Backend invokes a Publish_Mutation, THE Backend SHALL set the tenant from the validated SE-1 session.
4. WHEN sentiment is scored for a Call, THE Backend SHALL convey the score on the `Call.sentiment` field of published Call state.

### Requirement 11: Escalation Handoff (AC-4 → CP-3)

**User Story:** As an operator, I want to be notified when the AI escalates a call, so that a human can take over without the AI interfering.

#### Acceptance Criteria

1. WHEN the Bedrock_Reasoner escalates a Call, THE Backend SHALL invoke the CP-3 `publishCallEscalated` Publish_Mutation for that Call.
2. WHEN a Call has been escalated, THE AC_Runtime SHALL NOT re-engage the escalated issue on subsequent turns.
3. WHEN the Backend invokes `publishCallEscalated`, THE Backend SHALL set the tenant from the validated SE-1 session.

### Requirement 12: Lead Extraction (AC → CP-3)

**User Story:** As a business owner, I want leads captured from non-booking inquiries, so that I don't lose potential customers who didn't book.

#### Acceptance Criteria

1. WHEN a non-booking inquiry yields contactable lead information, THE Backend SHALL extract a Lead from the conversation.
2. WHEN a Lead is extracted, THE Backend SHALL invoke the CP-3 `publishLead` Publish_Mutation with the Lead.
3. WHEN the Backend invokes `publishLead`, THE Backend SHALL set the tenant from the validated SE-1 session.

### Requirement 13: Workflow Orchestration (WF-1)

**User Story:** As the platform, I want a workflow orchestrator coordinating multi-step actions, so that tool invocations and REST commands complete reliably.

#### Acceptance Criteria

1. THE Workflow_Orchestrator SHALL coordinate multi-step actions using Step Functions and EventBridge.
2. WHEN the Tool_Gateway or a CP-2 command initiates an action, THE Workflow_Orchestrator SHALL route the action to the appropriate service (Booking_Service, Orders_Service, or Notification_Service).
3. THE Workflow_Orchestrator SHALL propagate the `tenantId` to every step it invokes.
4. IF a workflow step fails, THEN THE Workflow_Orchestrator SHALL record the failure and surface an error outcome for the action.

### Requirement 14: Appointment Booking (WF-2)

**User Story:** As a caller, I want to book an appointment through the AI, so that I can schedule service without waiting for a human.

#### Acceptance Criteria

1. WHEN the Workflow_Orchestrator routes a booking action, THE Booking_Service SHALL create a booking scoped to the action's `tenantId`.
2. WHEN a booking is created, THE Booking_Service SHALL persist the booking to the Profile_Store with `PK = TENANT#<tenantId>`.
3. IF the requested booking slot is unavailable, THEN THE Booking_Service SHALL return an unavailable outcome without creating a booking.

### Requirement 15: Order Taking (WF-3)

**User Story:** As a caller, I want to place an order through the AI, so that I can purchase goods or services during the call.

#### Acceptance Criteria

1. WHEN the Workflow_Orchestrator routes an order action, THE Orders_Service SHALL create an order scoped to the action's `tenantId`.
2. WHEN an order is created, THE Orders_Service SHALL persist the order to the Profile_Store with `PK = TENANT#<tenantId>`.
3. IF an order request fails validation, THEN THE Orders_Service SHALL reject the order with a validation error and SHALL NOT persist a partial order.

### Requirement 16: Notifications (WF-4/WF-5)

**User Story:** As a caller and business owner, I want email and SMS confirmations sent, so that bookings and orders are confirmed across channels.

#### Acceptance Criteria

1. WHEN a booking or order is confirmed, THE Notification_Service SHALL send an email confirmation via SES.
2. WHEN a booking or order is confirmed AND an SMS-capable contact is present, THE Notification_Service SHALL send an SMS confirmation via SNS or Pinpoint.
3. THE Notification_Service SHALL scope notification content and recipients to the action's `tenantId`.
4. IF a notification delivery attempt fails, THEN THE Notification_Service SHALL record the delivery failure.

### Requirement 17: Short-Term Memory Store (DM-1)

**User Story:** As the AI agent, I want a fast short-term memory store, so that within-call context is available with low latency.

#### Acceptance Criteria

1. THE Short_Term_Store SHALL store short-term Call context in Redis.
2. THE Short_Term_Store SHALL key short-term entries by `tenantId` and Call session.
3. THE Short_Term_Store SHALL exclude other tenants' entries from reads performed in a given tenant's context.

### Requirement 18: Profile and Order Store (DM-2)

**User Story:** As the platform, I want durable profile and order storage partitioned by tenant, so that records persist with strict isolation.

#### Acceptance Criteria

1. THE Profile_Store SHALL store profiles and orders in DynamoDB.
2. THE Profile_Store SHALL partition every item with `PK = TENANT#<tenantId>`.
3. WHEN the Profile_Store executes a query, THE query SHALL be constrained to a single tenant partition.
4. IF a Profile_Store operation is attempted without a tenant partition key, THEN THE Profile_Store SHALL reject the operation.

### Requirement 19: Embedding Store (DM-3)

**User Story:** As the AI agent, I want a tenant-scoped embedding store, so that semantic recall draws only from the current tenant's data.

#### Acceptance Criteria

1. THE Embedding_Store SHALL store embeddings in pgvector or OpenSearch.
2. THE Embedding_Store SHALL tag every embedding with its `tenantId`.
3. WHEN the Embedding_Store performs a similarity search, THE search SHALL be restricted to the requesting `tenantId`.

### Requirement 20: Object Lake and Recording Consent (DM-4)

**User Story:** As a compliance owner, I want recordings and documents stored only after consent, so that the platform meets per-jurisdiction recording laws.

#### Acceptance Criteria

1. THE Object_Lake SHALL store recordings and documents in S3 partitioned by `tenantId`.
2. IF recording consent for the caller's jurisdiction has not been captured, THEN THE Backend SHALL NOT store the Call audio.
3. WHEN recording consent for the caller's jurisdiction has been captured, THE Object_Lake SHALL store the Call audio encrypted under the tenant's CP-4 key.

### Requirement 21: Stream Ingest (ML-1)

**User Story:** As the platform, I want call data streamed into the ML pipeline, so that sentiment and training data are available in near real time.

#### Acceptance Criteria

1. WHEN Call turn data is produced, THE Stream_Ingest SHALL ingest the data through Kinesis.
2. THE Stream_Ingest SHALL tag every ingested record with its `tenantId`.

### Requirement 22: Sentiment Scoring (ML-2)

**User Story:** As an operator, I want a live sentiment score per call, so that I can gauge caller satisfaction at a glance.

#### Acceptance Criteria

1. WHEN ingested Call data is processed, THE Sentiment_Scorer SHALL produce a sentiment score for the Call.
2. WHEN a sentiment score is produced, THE Backend SHALL publish the score onto the `Call.sentiment` field via CP-3.
3. THE Sentiment_Scorer SHALL scope each scored Call to its `tenantId`.

### Requirement 23: Model Training Pipeline (ML-4)

**User Story:** As an ML engineer, I want a SageMaker train/eval/registry pipeline, so that models improve from accumulated call data.

#### Acceptance Criteria

1. THE Model_Pipeline SHALL train, evaluate, and register models using SageMaker.
2. WHEN a trained model is evaluated, THE Model_Pipeline SHALL record evaluation metrics in the model registry.
3. WHEN a model is registered, THE Model_Pipeline SHALL record a registry entry that identifies the model version.

### Requirement 24: Model Deployment (ML-5)

**User Story:** As an ML engineer, I want improved models promoted to the agent runtime, so that callers benefit from better reasoning automatically.

#### Acceptance Criteria

1. WHEN a registered model's evaluation metrics exceed the currently deployed model's metrics, THE Model_Deployer SHALL promote the registered model to the AC_Runtime.
2. WHEN a model is promoted, THE Model_Deployer SHALL update the AC_Runtime to use the promoted model version.
3. IF a registered model's evaluation metrics do not exceed the deployed model's metrics, THEN THE Model_Deployer SHALL retain the currently deployed model.

### Requirement 25: Observability and Delivery SLO (CW)

**User Story:** As an operator of the platform, I want metrics and alarms including the live-update delivery latency, so that I can detect degradation in the dashboard experience.

#### Acceptance Criteria

1. THE Telemetry SHALL publish CloudWatch metrics for Backend components.
2. THE Telemetry SHALL publish the p95 latency of CP-3 subscription delivery as a CloudWatch metric.
3. WHEN a published metric crosses its configured alarm threshold, THE Telemetry SHALL raise a CloudWatch alarm.
