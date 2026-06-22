---
inclusion: always
---
# Stack & structure

- **CDK (serverless).** AgentCore, Step Functions/EventBridge, Lambda, DynamoDB, AppSync, Cognito, KMS,
  Kinesis, SageMaker, S3, CloudWatch.
- **Contracts are imported, not declared.** Boundary types from `alchemist_contracts` (Py). The CP-3
  AppSync schema is the SDL from `@alchemist/contracts` `graphql/schema.graphql` — load it, don't rewrite it.
- **MCP-first:** use the AWS MCP for resource shapes; prefer it over guessing.
- Folder convention (drives fileMatch steering): `agent/**` (AC), `workflows/**`, `data/**`, `ml/**`,
  `control-plane/**`.
