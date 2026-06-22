"""AC-4 reasoning layer for the 1145 AI AgentCore backend.

This package owns the Bedrock reasoner (task 12.1): it turns a caller turn into
a concrete :class:`~agentcore.reasoning.reasoner.Action` or escalates to a human
via an :class:`~agentcore.reasoning.reasoner.Escalation` when it is not confident
or Guardrails block the candidate (design "AC-4 — Bedrock Reasoner + Guardrails";
Requirements 9.1–9.4, 11.1, 11.2).

Per-turn live publication (task 12.2) and lead extraction (task 12.3) are not
implemented here, but the reasoner is designed so they plug in: both can reuse
the injected
:class:`~agentcore.reasoning.reasoner.CallStatePublisher`.
"""

from agentcore.reasoning.reasoner import (
    DEFAULT_CONFIDENCE_THRESHOLD,
    Action,
    BedrockReasoner,
    BedrockReasoningClient,
    Call,
    CallStatePublisher,
    Escalation,
    EscalationReason,
    InvalidTurnError,
    ReasonerError,
    ReasoningCandidate,
    ReasoningContext,
    ReasoningRequest,
    ReasoningScopeError,
    ReasonResult,
    Turn,
)

__all__ = [
    "DEFAULT_CONFIDENCE_THRESHOLD",
    "BedrockReasoner",
    "Turn",
    "ReasoningContext",
    "ReasoningRequest",
    "ReasoningCandidate",
    "BedrockReasoningClient",
    "Call",
    "CallStatePublisher",
    "EscalationReason",
    "Action",
    "Escalation",
    "ReasonResult",
    "ReasonerError",
    "ReasoningScopeError",
    "InvalidTurnError",
]
