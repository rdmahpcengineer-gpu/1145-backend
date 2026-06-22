# alchemist-backend — Architecture

The AWS platform: reasoning, workflows, data, ML, control plane. CDK serverless. Built in Kiro.

| Group | IDs | Components |
|---|---|---|
| Control plane | CP-1..4 | Cognito (tenant/operator) · API Gateway REST · **AppSync (CP-3)** · KMS per-tenant keys |
| AgentCore | AC-1..4 | Runtime · Tool Gateway · Memory · Bedrock LLM + Guardrails |
| Workflows | WF-1..5 | Step Functions/EventBridge · Booking · Orders · SES · SNS/Pinpoint |
| Data | DM-1..4 | Redis · DynamoDB · pgvector/OpenSearch · S3 lake |
| ML | ML-1/2/4/5 | Kinesis · Sentiment · SageMaker · Deploy |
| Observability | CW | CloudWatch |

## CP-3 AppSync — provisioned from contracts
- **Import the SDL** from `@alchemist/contracts` `graphql/schema.graphql`. Do **not** re-declare types in CDK.
- Query/Subscription resolvers read DynamoDB (DM-2) scoped by tenant (`PK = TENANT#<tenantId>`).
- `publish*` mutations are **IAM-auth no-op resolvers** whose only job is to fan out to subscriptions.
- AC-1..4 / WF-1 call `publishCallUpdate`, `appendTranscript`, `publishLead`, `publishCallEscalated`
  as they process SE-1 input from middleware. Live caller score (ML+memory) rides `Call.sentiment`.
- The dashboard never writes via AppSync — writes arrive on **CP-2 REST** (commands).

## Auth (CP-1)
Tenant/operator user pool — **separate** from the investor-portal pool in the frontend's Amplify (D-002).

## Isolation
Every record partitioned `PK = TENANT#<id>`; per-tenant KMS key (CP-4); no cross-tenant reads.
