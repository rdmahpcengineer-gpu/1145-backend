---
inclusion: always
---
# Product context

Alchemist Business OS ("1145 AI") is an AI voice-agent platform for small businesses (HVAC, dental,
salons). A caller dials a business; an AI answers, books appointments, takes orders, captures leads, and
escalates to a human when unsure. The owner/operator watches everything from a dashboard.

Backend's job: the reasoning + workflows + data + ML + control plane behind that. The voice edge
(Telnyx/LiveKit) is a separate repo; this platform receives utterances over SE-1 and pushes live state
to the dashboard over CP-3 AppSync.

Two distinct audiences/pools: **tenant/operator** (this platform, CP-1) and **investor portal**
(frontend Amplify) — never merged.
