---
inclusion: fileMatch
fileMatchPattern: 'workflows/**|data/**|ml/**|control-plane/**'
---
# Workflows · Data · ML · Control plane

- **WF-1..5:** Step Functions/EventBridge orchestration; Booking/Orders Lambdas; SES email; SNS/Pinpoint
  SMS. CP-2 REST commands route here.
- **DM-1..4:** Redis short-term; DynamoDB profiles/orders (PK=TENANT#); pgvector/OpenSearch embeddings;
  S3 lake (recordings/docs).
- **ML-1/2/4/5:** Kinesis ingest; sentiment scoring published onto `Call.sentiment`; SageMaker
  train/eval/registry; deploy promotes improved models to the AgentCore runtime.
- **CP-3 AppSync provisioning:** source the GraphQL SDL from the contracts package — never hand-author in
  CDK. `publish*` mutations are `@aws_iam` and invoked by AgentCore/workflows; reads/subscriptions are
  `@aws_cognito_user_pools`. The dashboard never writes through AppSync.
