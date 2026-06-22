# Build prompt — alchemist-backend (Kiro)

Fork `awslabs/amazon-bedrock-agentcore-samples`. Steering loads from `.kiro/steering/`. Use the **AWS MCP**.
Import boundary types from `alchemist_contracts` (Py).

1. **Control plane:** Cognito tenant/operator pool (CP-1), API Gateway REST (CP-2) implementing the
   contracts `openapi.yaml`, **AppSync (CP-3) built from `@alchemist/contracts` `graphql/schema.graphql`**,
   per-tenant KMS (CP-4).
2. **AgentCore (AC-1..4):** Runtime holding session+tenant ctx, Tool Gateway → workflows, Memory hydrate,
   Bedrock LLM + Guardrails. On each turn from SE-1, publish call state via the CP-3 `publish*` mutations.
3. **Workflows (WF-1..5):** Step Functions/EventBridge, Booking, Orders, SES, SNS/Pinpoint. CP-2 commands
   route here.
4. **Data (DM-1..4):** Redis, DynamoDB (PK=TENANT#), pgvector/OpenSearch embeddings, S3 lake.
5. **ML (ML-1/2/4/5):** Kinesis ingest, sentiment scoring → `Call.sentiment`, SageMaker train/deploy.
6. **CW:** metrics + alarms; publish the CP-3 subscription delivery p95.

CP-3 carries no user-facing mutations — those are CP-2 REST.
