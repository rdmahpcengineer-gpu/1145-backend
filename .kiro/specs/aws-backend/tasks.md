# Implementation Plan: AWS Backend (1145 AI)

## Overview

This plan converts the approved design into incremental coding tasks for a CDK-serverless
backend (TypeScript CDK + TypeScript Lambdas, Python AgentCore forked from
`awslabs/amazon-bedrock-agentcore-samples`). Work is organized to the steering folder
convention (`agent/**`, `workflows/**`, `data/**`, `ml/**`, `control-plane/**`) and the
design's CDK stacks (`DataStack`, `ControlPlaneStack`, `AgentStack`, `WorkflowStack`,
`MlStack`).

Sequencing follows the design's deployment dependency: the **DynamoDB single table and the
CP-4 per-tenant KMS strategy come first** (every other stack depends on the table and keys),
then control plane, agent, workflows, ML, and observability. Each step builds on prior steps
and ends wired into the system — no orphaned code.

Boundary contracts are **imported, never authored**: SE-1 proto, AC-2 tool schema, CP-2
`openapi.yaml`, and CP-3 `graphql/schema.graphql` SDL are loaded/consumed from
`@alchemist/contracts` / `alchemist_contracts`. Tasks must reference these artifacts, never
re-declare them.

Multi-tenant isolation is enforced at every layer; the operative `tenantId` is derived only
from a Validated_Session (Cognito CP-1, or independently-validated SE-1 per assumption A3).
Assumptions A1 (backend-enforced consent gate), A2 (automatic promotion with configurable
approval hook), and A3 (independent SE-1 validation) are honored in the relevant tasks.

**Property-based testing:** the design defines 23 correctness properties. Each property maps
to exactly one property-based test (`fast-check` for TypeScript, `hypothesis` for Python),
minimum 100 iterations, tagged `Feature: aws-backend, Property {n}: ...`. PBT, unit/example,
integration, and CDK synth/snapshot tasks from the design's Testing Strategy are all included.
Sub-tasks marked `*` are optional tests and are not auto-implemented.

## Tasks

- [x] 1. Bootstrap CDK app and contract import wiring
  - [x] 1.1 Initialize the CDK TypeScript app and folder convention
    - Create the CDK app with a single `BackendApp` composing empty `DataStack`,
      `ControlPlaneStack`, `AgentStack`, `WorkflowStack`, `MlStack`
    - Lay out the folder convention: `agent/**`, `workflows/**`, `data/**`, `ml/**`,
      `control-plane/**`; configure cross-stack wiring via stack outputs / SSM parameters
    - Set up the test runners: `fast-check` + the chosen JS test runner for TS, `hypothesis`
      + `pytest` for Python AgentCore
    - _Requirements: 5.1_
  - [x] 1.2 Implement imported-contract loaders
    - Load (never re-author) the CP-2 `openapi.yaml`, CP-3 `graphql/schema.graphql` SDL,
      AC-2 tool schema, and SE-1 proto from `@alchemist/contracts` / `alchemist_contracts`
    - Expose typed loader helpers that surface the contract artifacts to the stacks/Lambdas
    - _Requirements: 2.2, 3.2, 7.2_
  - [ ]* 1.3 Write unit tests for contract loaders
    - Verify loaders resolve the imported artifacts and fail loudly if an artifact is missing
    - Verify no contract types are declared locally
    - _Requirements: 2.2, 3.2, 7.2_

- [x] 2. DataStack foundation: DynamoDB single table, KMS strategy, tenant persistence/query wrappers
  - [x] 2.1 Provision the DM-2 DynamoDB single table
    - Define the single table with `PK`/`SK`, `entityType`, `tenantId`, `data`, `createdAt`;
      enable KMS encryption
    - Export the table name for cross-stack consumers
    - _Requirements: 18.1, 18.2_
  - [x] 2.2 Implement the CP-4 per-tenant KMS key strategy and tenant key resolver
    - Provision per-tenant symmetric KMS keys via a `TenantProvisioning` onboarding custom
      resource using alias `alias/tenant/<tenantId>`; restrict key policy to the tenant's roles
    - Implement `data/crypto/tenant_key` `keyForTenant(tenantId) -> kmsKeyArn`; callers never
      pass a raw key ARN
    - _Requirements: 4.1, 4.2, 4.3_
  - [x] 2.3 Implement the shared tenant persistence wrapper
    - Wrap all writes so every item carries `PK = TENANT#<tenantId>`; reject any write missing
      a tenant partition key before it reaches DynamoDB
    - _Requirements: 5.1, 5.3, 18.2, 18.4_
  - [x] 2.4 Implement the shared tenant query builder
    - Build reads with a `KeyConditionExpression` pinned to `PK = TENANT#<tenantId>`; reject any
      query lacking a tenant scope; filter out any non-matching tenant from results
    - _Requirements: 5.2, 5.5, 18.3_
  - [ ]* 2.5 Write property test for the persistence wrapper
    - **Property 3: Every persisted record is tenant-partitioned**
    - **Validates: Requirements 5.1, 14.2, 15.2, 18.2**
  - [ ]* 2.6 Write property test for unscoped-operation rejection
    - **Property 2: Operations without a tenant scope are rejected**
    - **Validates: Requirements 1.5, 5.3, 18.4**
  - [ ]* 2.7 Write property test for the tenant key resolver
    - **Property 8: A tenant's key is used only for that tenant's data**
    - **Validates: Requirements 4.2, 4.3, 20.3**
  - [ ]* 2.8 Write property test for the tenant query builder
    - **Property 4: Every read is tenant-scoped and returns no cross-tenant data**
    - **Validates: Requirements 3.5, 5.2, 5.5, 8.3, 8.4, 9.4, 16.3, 17.3, 18.3, 19.3, 22.3**

- [x] 3. Remaining data stores: Redis (DM-1), embeddings (DM-3), object lake + consent (DM-4)
  - [x] 3.1 Implement the DM-1 Redis short-term store
    - Provision ElastiCache Redis; key entries `t:<tenantId>:call:<callId>:...` with call-lifetime
      TTL; confine reads to the tenant's key prefix
    - _Requirements: 17.1, 17.2, 17.3_
  - [x] 3.2 Implement the DM-3 embedding store and shared tenant-tagging helper
    - Provision pgvector (Aurora/OpenSearch); implement a shared tenant-tagging helper that tags
      every embedding with `tenantId`; restrict similarity search with a `tenantId = :t` predicate
    - _Requirements: 19.1, 19.2, 19.3_
  - [x] 3.3 Implement the DM-4 S3 object lake and consent gate (A1)
    - Provision the S3 lake with layout `<tenantId>/recordings/...` and `<tenantId>/docs/...`,
      SSE-KMS under the tenant's CP-4 key
    - Enforce the consent gate in the backend: before any audio `PutObject`, check the
      `CONSENT#<callId>` record for the jurisdiction; fail closed when consent is absent/ambiguous
    - _Requirements: 20.1, 20.2, 20.3_
  - [ ]* 3.4 Write property test for object-lake partitioning
    - **Property 20: Stored objects are partitioned by owning tenant**
    - **Validates: Requirements 20.1**
  - [ ]* 3.5 Write property test for the consent gate
    - **Property 21: Audio is stored only after consent is captured**
    - **Validates: Requirements 20.2, 20.3**
  - [ ]* 3.6 Write property test for tenant tagging (embeddings + ingest)
    - **Property 22: Embeddings and ingested records are tagged with their tenant**
    - **Validates: Requirements 19.2, 21.2**

- [~] 4. Checkpoint - data layer
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Control plane: CP-1 Cognito and tenant derivation
  - [x] 5.1 Provision the CP-1 Cognito tenant/operator user pool
    - Create a dedicated `UserPool` with `custom:tenantId`, separate from any investor pool;
      issue tokens whose claims include `tenantId`; expose the Cognito authorizer/auth provider
    - _Requirements: 1.1, 1.2, 1.3_
  - [x] 5.2 Implement the shared tenant-derivation helper
    - Derive the operative `tenantId` from a Validated_Session (Cognito claim, or validated SE-1
      tenant); ignore any client-supplied tenant value; reject requests with no Validated_Session
    - _Requirements: 1.4, 1.5, 5.4_
  - [ ]* 5.3 Write property test for tenant derivation
    - **Property 1: Tenant is derived from the validated session, never the client**
    - **Validates: Requirements 1.4, 5.4, 6.3**

- [x] 6. Control plane: CP-2 REST command API
  - [x] 6.1 Provision the CP-2 `SpecRestApi` from the imported `openapi.yaml`
    - Build the REST API from the imported contract artifact with model validation enabled;
      protect every method with the CP-1 Cognito authorizer; do not declare paths/models locally
    - _Requirements: 2.1, 2.2, 2.3, 6.6_
  - [x] 6.2 Implement CP-2 command handlers
    - Derive `tenantId` from the authorizer context; scope all data access to that tenant; route
      fulfillment to `WF-1.start(tenantId, command)`; reject non-conforming requests
    - _Requirements: 2.3, 2.4, 2.5, 2.6_
  - [ ]* 6.3 Write integration tests for CP-2 authorize and route
    - Valid token authorizes and starts WF-1; invalid/missing token is rejected; non-conforming
      payload returns a validation error
    - _Requirements: 2.3, 2.4, 2.6_

- [x] 7. Control plane: CP-3 AppSync live-state API
  - [x] 7.1 Provision the CP-3 AppSync API from the imported SDL
    - Load the SDL from `@alchemist/contracts` `graphql/schema.graphql`; configure auth modes:
      primary `AMAZON_COGNITO_USER_POOLS` (reads/subscriptions) and additional `AWS_IAM`
      (publish mutations); do not re-author types in CDK
    - _Requirements: 3.1, 3.2, 3.3, 3.4_
  - [x] 7.2 Implement read/subscription resolvers
    - Resolve against DM-2 pinned to `PK = TENANT#<tenantId>` from the Cognito identity; apply any
      subscription `tenant` argument only as an additional filter that can never widen scope
    - _Requirements: 3.5, 3.6, 3.8_
  - [x] 7.3 Implement publish (fan-out) resolvers
    - Implement `publishCallUpdate`, `appendTranscript`, `publishLead`, `publishCallEscalated` as
      no-op fan-out resolvers (NONE/local) that set tenant from the validated SE-1 session and
      perform no persistent write
    - _Requirements: 3.7, 10.3, 11.3, 12.3_
  - [ ]* 7.4 Write property test for subscription argument scoping
    - **Property 5: A subscription tenant argument is a filter, not an authorization boundary**
    - **Validates: Requirements 3.6**
  - [ ]* 7.5 Write property test for publish resolvers
    - **Property 6: Publish mutations set tenant from the validated SE-1 session and never persist**
    - **Validates: Requirements 3.7, 10.3, 11.3, 12.3**

- [~] 8. Checkpoint - control plane
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. AgentCore: SE-1 validator and AC-1 runtime (Python)
  - [x] 9.1 Implement the SE-1 session validator (A3)
    - In `agent/session/se1_validator`, independently validate signature/issuer/expiry and tenant
      existence; output a trusted `tenantId`; this is the only acceptable tenant source for an
      AC session or a Publish_Mutation
    - _Requirements: 6.3_
  - [x] 9.2 Implement the AC-1 runtime and session context
    - On `CallStart`, create a Redis-backed session holding `{ callId, tenantId, escalatedIssues,
      modelVersion }` for the call duration; associate each turn with the session/`tenantId`;
      release context on `CallEnd` (`startSession`/`withSession`/`endSession`)
    - _Requirements: 6.1, 6.2, 6.4_
  - [ ]* 9.3 Write property test for session tenant persistence
    - **Property 9: AC session holds the validated tenant for the whole call**
    - **Validates: Requirements 6.1, 6.2**
  - [ ]* 9.4 Write property test for session release
    - **Property 10: Ending a call releases its session context**
    - **Validates: Requirements 6.4**

- [x] 10. AgentCore: AC-2 Tool Gateway (Python)
  - [x] 10.1 Implement the Tool Gateway
    - Validate tool calls against the imported AC-2 tool schema; reject non-conforming invocations
      with a validation error; on a valid action route to `WF-1.start(session.tenantId, action)`
    - _Requirements: 7.1, 7.3, 7.4, 7.5_
  - [ ]* 10.2 Write property test for tool-schema validation
    - **Property 11: Non-conforming tool invocations are rejected**
    - **Validates: Requirements 7.5**

- [x] 11. AgentCore: AC-3 Memory (Python)
  - [x] 11.1 Implement memory hydration
    - Hydrate short-term (DM-1 Redis) and long-term (DM-3 embeddings) context scoped to
      `session.tenantId`; exclude any other tenant's context by construction
    - _Requirements: 8.1, 8.2, 8.3, 8.4_
  - [ ]* 11.2 Write unit tests for memory isolation
    - Verify hydration over a multi-tenant fixture returns only the session tenant's context
    - _Requirements: 8.3, 8.4_

- [x] 12. AgentCore: AC-4 Reasoner, escalation, live publication, lead extraction (Python)
  - [x] 12.1 Implement the Bedrock reasoner with Guardrails and confidence gate
    - Generate responses with Bedrock + Guardrails scoped to `session.tenantId`; below-threshold
      confidence or a Guardrails block yields an escalation rather than a guessed action;
      mark the issue in `session.escalatedIssues` and trigger `publishCallEscalated`; never
      re-engage an escalated issue
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 11.1, 11.2_
  - [x] 12.2 Wire per-turn live publication
    - On turn completion invoke `publishCallUpdate`; on finalized utterance invoke
      `appendTranscript`; set tenant from the validated SE-1 session on every publish
    - _Requirements: 10.1, 10.2, 10.3_
  - [x] 12.3 Implement lead extraction
    - Extract a Lead from a non-booking inquiry with contactable info and invoke `publishLead`
      with tenant from the validated SE-1 session
    - _Requirements: 12.1, 12.2, 12.3_
  - [ ]* 12.4 Write property test for escalation gating
    - **Property 12: Below-threshold or blocked reasoning escalates instead of acting**
    - **Validates: Requirements 9.2, 9.3**
  - [ ]* 12.5 Write property test for escalation finality
    - **Property 13: An escalated issue is never re-engaged**
    - **Validates: Requirements 11.2**
  - [ ]* 12.6 Write unit tests for lead extraction
    - Lead extracted when contactable info is present; none when absent
    - _Requirements: 12.1_

- [~] 13. Checkpoint - agent
  - Ensure all tests pass, ask the user if questions arise.

- [x] 14. WorkflowStack: WF-1 orchestrator
  - [x] 14.1 Implement the WF-1 Step Functions + EventBridge orchestrator
    - Build the state machine fronted by an EventBridge bus; route an initiating action (Tool
      Gateway or CP-2 command) to Booking/Orders/Notification; propagate `tenantId` into every
      state input; on step failure write a tenant-scoped `FAILURE#<execId>` record, emit a CW
      metric, and return an error outcome
    - _Requirements: 13.1, 13.2, 13.3, 13.4_
  - [ ]* 14.2 Write property test for tenant propagation
    - **Property 7: TenantId propagates unchanged across tool → workflow → steps**
    - **Validates: Requirements 7.4, 13.3, 14.1, 15.1**
  - [ ]* 14.3 Write property test for action routing
    - **Property 15: Orchestrator routes each action to its matching service**
    - **Validates: Requirements 13.2**
  - [ ]* 14.4 Write property test for failure recording
    - **Property 16: Failures are recorded and surfaced as error outcomes**
    - **Validates: Requirements 13.4, 16.4**

- [x] 15. WorkflowStack: WF-2 Booking Service
  - [x] 15.1 Implement the Booking Lambda
    - Create a booking scoped to the action `tenantId` and persist to DM-2 with
      `PK = TENANT#<tenantId>`; if the slot is unavailable, return an unavailable outcome and
      create nothing
    - _Requirements: 14.1, 14.2, 14.3_
  - [ ]* 15.2 Write property test for unavailable slots
    - **Property 17: Unavailable booking slots create nothing**
    - **Validates: Requirements 14.3**

- [x] 16. WorkflowStack: WF-3 Orders Service
  - [x] 16.1 Implement the Orders Lambda
    - Create an order scoped to `tenantId` and persist to DM-2 with `PK = TENANT#<tenantId>` using
      a single conditional write; reject invalid orders with a validation error and persist no
      partial order
    - _Requirements: 15.1, 15.2, 15.3_
  - [ ]* 16.2 Write property test for invalid orders
    - **Property 18: Invalid orders persist no partial state**
    - **Validates: Requirements 15.3**

- [x] 17. WorkflowStack: WF-4/5 Notification Service
  - [x] 17.1 Implement the Notification Lambda
    - On confirmation send email via SES; if an SMS-capable contact exists also send SMS via
      SNS/Pinpoint; scope content/recipients to the action `tenantId`; record delivery failures
    - _Requirements: 16.1, 16.2, 16.3, 16.4_
  - [ ]* 17.2 Write property test for conditional SMS
    - **Property 19: SMS is sent exactly when an SMS-capable contact exists**
    - **Validates: Requirements 16.2**

- [~] 18. Checkpoint - workflows
  - Ensure all tests pass, ask the user if questions arise.

- [x] 19. MlStack: ML-1 stream ingest
  - [x] 19.1 Implement the ML-1 Kinesis ingest pipeline
    - Provision the Kinesis stream; produce call-turn records tagged with `tenantId` (tenant in the
      partition key) from the runtime
    - _Requirements: 21.1, 21.2_

- [x] 20. MlStack: ML-2 sentiment scoring
  - [x] 20.1 Implement the Sentiment Scorer Lambda
    - Consume ingested data, produce a per-Call sentiment score scoped to `tenantId`, and publish it
      onto `Call.sentiment` via `publishCallUpdate` (tenant from the validated session)
    - _Requirements: 22.1, 22.2, 22.3, 10.4_
  - [ ]* 20.2 Write property test for sentiment publication
    - **Property 14: Sentiment scores ride Call.sentiment**
    - **Validates: Requirements 10.4, 22.2**

- [x] 21. MlStack: ML-4 pipeline and ML-5 deployer
  - [x] 21.1 Implement the ML-4 SageMaker train/eval/registry pipeline
    - Build the SageMaker pipeline that trains, evaluates, and registers models; record eval
      metrics and a version-identifying registry entry
    - _Requirements: 23.1, 23.2, 23.3_
  - [x] 21.2 Implement the ML-5 Model Deployer with approval hook (A2)
    - Compare candidate vs deployed metrics; promote iff candidate exceeds deployed, gated by a
      configurable approval-gate hook (default auto-promote); on promote update the AC_Runtime model
      version; otherwise retain the deployed model; retain on missing/incomparable metrics
    - _Requirements: 24.1, 24.2, 24.3_
  - [ ]* 21.3 Write property test for promotion decision
    - **Property 23: A model is promoted exactly when its metrics exceed the deployed model's**
    - **Validates: Requirements 24.1, 24.3**
  - [ ]* 21.4 Write integration test for pipeline and promotion
    - Pipeline trains/evaluates/registers with metrics + version; a Promote decision updates the
      runtime model version
    - _Requirements: 23.1, 23.2, 23.3, 24.2_

- [~] 22. Checkpoint - ML
  - Ensure all tests pass, ask the user if questions arise.

- [x] 23. ControlPlaneStack: CW observability and delivery SLO
  - [x] 23.1 Implement CW metrics and alarms
    - Publish CloudWatch metrics for backend components including the p95 latency of CP-3
      subscription delivery (publish invocation → subscription delivery); raise alarms when a
      metric crosses its configured threshold
    - _Requirements: 25.1, 25.2, 25.3_

- [ ] 24. Integration and synth/snapshot verification
  - [ ]* 24.1 Write integration tests for cross-component flows
    - Cognito issues `tenantId` tokens; CP-2 authorizer accepts valid/rejects invalid; authorized
      CP-2 command and selected tool action start WF-1; turn completion invokes
      `publishCallUpdate`/`appendTranscript`; escalation invokes `publishCallEscalated`; lead
      invokes `publishLead`; SES email and SMS send paths; Kinesis ingest + sentiment score;
      CP-3 p95 metric emission and alarm transition
    - _Requirements: 1.3, 2.3, 2.4, 7.3, 10.1, 10.2, 11.1, 12.2, 16.1, 21.1, 22.1, 25.2, 25.3_
  - [ ]* 24.2 Write CDK synth/snapshot tests
    - CP-1 user pool exists and is independent of any investor pool; CP-2 `SpecRestApi` built from
      the imported `openapi.yaml` with no local OpenAPI; CP-3 AppSync sourced from the imported SDL
      with no hand-authored types and correct Cognito/IAM auth; per-tenant KMS key + alias on
      onboarding; WF-1 state machine + EventBridge bus; DynamoDB table, embedding store, and CW
      metrics/alarms exist
    - _Requirements: 1.1, 1.2, 2.1, 2.2, 3.1, 3.2, 3.3, 3.4, 3.8, 4.1, 13.1, 18.1, 19.1, 25.1_
  - [ ]* 24.3 Write unit tests for lead extraction edge cases
    - Contactable vs non-contactable inquiries (complements the property suite)
    - _Requirements: 12.1_

- [~] 25. Final checkpoint - full system
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; they are
  not auto-implemented.
- The 23 design properties map one-to-one to property-based tests: P1→5.3, P2→2.6, P3→2.5,
  P4→2.8, P5→7.4, P6→7.5, P7→14.2, P8→2.7, P9→9.3, P10→9.4, P11→10.2, P12→12.4, P13→12.5,
  P14→20.2, P15→14.3, P16→14.4, P17→15.2, P18→16.2, P19→17.2, P20→3.4, P21→3.5, P22→3.6, P23→21.3.
- Property tests use `fast-check` (TypeScript) / `hypothesis` (Python), minimum 100 iterations,
  tagged `Feature: aws-backend, Property {n}: ...`, with external services mocked.
- Boundary contracts (SE-1, AC-2, CP-2 `openapi.yaml`, CP-3 SDL) are imported and consumed, never
  re-declared.
- `DataStack` (table) and the CP-4 KMS strategy are built first because every other stack depends
  on the table and per-tenant keys.
- Assumptions honored: A1 (backend-enforced consent gate, task 3.3), A2 (auto-promotion with
  configurable approval hook, task 21.2), A3 (independent SE-1 validation, task 9.1).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "2.2"] },
    { "id": 2, "tasks": ["1.3", "2.3", "2.4"] },
    { "id": 3, "tasks": ["2.5", "2.6", "2.7", "2.8", "3.1", "3.2", "3.3", "5.1"] },
    { "id": 4, "tasks": ["3.4", "3.5", "3.6", "5.2"] },
    { "id": 5, "tasks": ["5.3", "6.1", "7.1", "9.1"] },
    { "id": 6, "tasks": ["6.2", "7.2", "7.3", "9.2"] },
    { "id": 7, "tasks": ["6.3", "7.4", "7.5", "9.3", "9.4", "10.1", "11.1"] },
    { "id": 8, "tasks": ["10.2", "11.2", "12.1", "14.1"] },
    { "id": 9, "tasks": ["12.2", "12.3", "12.4", "12.5", "12.6", "14.2", "14.3", "14.4", "15.1", "16.1", "17.1", "19.1"] },
    { "id": 10, "tasks": ["15.2", "16.2", "17.2", "20.1", "21.1", "21.2"] },
    { "id": 11, "tasks": ["20.2", "21.3", "21.4", "23.1"] },
    { "id": 12, "tasks": ["24.1", "24.2", "24.3"] }
  ]
}
```
