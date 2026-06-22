# 1145 AI — AWS Backend: Implementation Summary

The **AWS platform** behind the Alchemist Business OS ("1145 AI") voice‑agent: reasoning,
workflows, data, ML, and control plane. CDK serverless (TypeScript) with the Bedrock AgentCore
layer in Python. Built spec‑first (`.kiro/specs/aws-backend/`: requirements → design → tasks).

## Status

- **50 / 50 required implementation tasks complete.**
- **Build green:** `tsc --noEmit` clean · **418 TypeScript tests** (unit + CDK synth/snapshot) ·
  **139 Python tests** passing.
- Remaining work is the **optional** (`*`) suite: formal property‑based tests (one per the 23
  design correctness properties), cross‑component integration tests, and checkpoint markers.

## What was built

### Control plane (CP‑1..4 + CW)
- **CP‑1** Cognito tenant/operator user pool with `custom:tenantId`, separate from the investor pool.
- **CP‑2** API Gateway `SpecRestApi` built from the imported `openapi.yaml`, CP‑1 authorizer on every
  method, spec‑driven validation, command handlers that route to WF‑1.
- **CP‑3** AppSync provisioned from the imported `graphql/schema.graphql` SDL — Cognito‑auth
  read/subscription resolvers pinned to `PK = TENANT#<tenantId>`, and IAM no‑op fan‑out resolvers for
  `publishCallUpdate` / `appendTranscript` / `publishLead` / `publishCallEscalated`.
- **CP‑4** per‑tenant KMS keys minted at onboarding (`alias/tenant/<tenantId>`) + tenant key resolver.
- **CW** CloudWatch metrics + alarms, including the CP‑3 subscription‑delivery **p95** SLO.

### AgentCore (AC‑1..4, Python — forked layout from amazon-bedrock-agentcore-samples)
- **SE‑1 validator** (assumption A3): independent signature/issuer/expiry + tenant‑existence checks.
- **AC‑1** runtime/session lifecycle holding the validated tenant for the call.
- **AC‑2** Tool Gateway validating against the imported AC‑2 tool schema, routing to WF‑1.
- **AC‑3** Memory hydration (Redis short‑term + pgvector long‑term), tenant‑scoped, defense‑in‑depth.
- **AC‑4** Bedrock reasoner + Guardrails, confidence‑gated escalation (one‑way), per‑turn live
  publication to CP‑3, and lead extraction.

### Workflows (WF‑1..5)
- **WF‑1** Step Functions + EventBridge orchestrator: action routing, `tenantId` propagation to every
  state, failure recording (`FAILURE#<execId>` in DM‑2 + CW metric).
- **WF‑2** Booking, **WF‑3** Orders (single conditional writes), **WF‑4/5** SES email + conditional
  SNS SMS with delivery‑failure recording.

### Data (DM‑1..4)
- DM‑2 DynamoDB single table (`PK = TENANT#<tenantId>`) with shared tenant persistence/query wrappers,
  DM‑1 Redis short‑term, DM‑3 pgvector embeddings (tenant‑tagged), DM‑4 S3 lake partitioned by tenant
  with the **backend‑enforced consent gate** (assumption A1, fail‑closed) and per‑tenant SSE‑KMS.

### ML (ML‑1/2/4/5)
- Kinesis ingest (tenant‑tagged records), sentiment scoring published onto `Call.sentiment` via CP‑3,
  SageMaker train/eval/registry pipeline, and the model deployer with a **configurable approval‑gate
  hook** (assumption A2, default auto‑promote).

## Cross‑cutting guarantees
- **Multi‑tenant isolation** at every layer: every record `PK = TENANT#<tenantId>`; tenant derived only
  from a validated session (Cognito CP‑1 / validated SE‑1), never a client field; per‑tenant KMS.
- **Contracts are imported, never authored** (SE‑1 proto, AC‑2 tool schema, CP‑2 openapi, CP‑3 SDL).
  Documented local fixtures let `cdk synth`/tests run when `@alchemist/contracts` isn't linked.
- **Design assumptions** A1 (backend consent gate), A2 (auto‑promotion + approval hook), A3
  (independent SE‑1 validation) are implemented and flagged for revisit.

## Layout
`control-plane/**` · `agent/**` (Python) · `workflows/**` · `data/**` · `ml/**` · `shared/**` ·
`lib/` + `bin/` (CDK app) · `.kiro/specs/aws-backend/` (requirements, design, tasks).

## Build & test
```bash
npm install
npx tsc --noEmit          # type-check
npx jest                  # TS unit + CDK synth tests
npx cdk synth             # synthesize stacks
cd agent && pytest        # Python AgentCore tests
```
