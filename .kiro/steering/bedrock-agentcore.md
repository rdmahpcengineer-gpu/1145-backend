---
inclusion: fileMatch
fileMatchPattern: 'agent/**'
---
# AgentCore (AC-1..4) conventions

- **AC-1 Runtime:** holds session + tenant context for the call duration.
- **AC-2 Tool Gateway:** invokes tools → WF-1 using the AC-2 tool schema from contracts.
- **AC-3 Memory:** hydrate short/long-term (Redis + pgvector). Tenant-scoped.
- **AC-4 Bedrock + Guardrails:** reasoning + safety. Confidence-gated — escalate rather than guess.
- On each turn, publish live state to CP-3 via `publishCallUpdate` / `appendTranscript`; on escalation
  publish `publishCallEscalated` (one-way — the AI does not re-engage an escalated issue).
- Lead extraction from non-booking inquiries → `publishLead`.
