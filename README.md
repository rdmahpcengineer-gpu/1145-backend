# 1145-backend

AWS platform for the Alchemist Business OS ("1145 AI") AI voice-agent — reasoning, workflows,
data, ML, and control plane. CDK serverless (TypeScript) with the Bedrock AgentCore layer in Python.

See [SUMMARY.md](./SUMMARY.md) for the full implementation overview and [`.kiro/specs/aws-backend/`](./.kiro/specs/aws-backend/)
for the requirements, design, and task plan.

## Build & test

```bash
npm install
npx tsc --noEmit          # type-check
npx jest                  # TypeScript unit + CDK synth tests
npx cdk synth             # synthesize stacks
cd agent && pytest        # Python AgentCore tests
```
