---
inclusion: always
---
# Multi-tenant isolation — non-negotiable

- Every record partitioned `PK = TENANT#<tenantId>`. No query runs without a tenant scope.
- Per-tenant KMS key (CP-4). No cross-tenant reads, caches, or logs.
- Tenant comes from the Cognito session (CP-1), never from a client-supplied field alone.
- AppSync resolvers enforce tenant in the resolver — a subscription argument is a filter, not an auth
  boundary. IAM `publish*` mutations set tenant from the validated SE-1 session.
- Recording/consent captured per jurisdiction before audio is stored (DM-4).
