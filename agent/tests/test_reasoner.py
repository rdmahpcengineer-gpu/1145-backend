"""Unit tests for the AC-4 Bedrock reasoner (task 12.1).

Example-based tests covering tenant scoping, the confidence gate, the Guardrails
gate, escalation marking + publication, and escalation finality. The Property
12/13 property-based tests are separate tasks (12.4/12.5) and are not
implemented here.

Validates: Requirements 9.1, 9.2, 9.3, 9.4, 11.1, 11.2
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from agentcore.reasoning.reasoner import (
    DEFAULT_CONFIDENCE_THRESHOLD,
    Action,
    BedrockReasoner,
    Call,
    Escalation,
    EscalationReason,
    InvalidTurnError,
    ReasonerError,
    ReasoningCandidate,
    ReasoningContext,
    ReasoningRequest,
    ReasoningScopeError,
    Turn,
)
from agentcore.session.runtime import AgentRuntime
from agentcore.session.se1_validator import ValidatedSe1Session

TENANT = "tenant-abc"
OTHER_TENANT = "tenant-xyz"
CALL = "call-001"
MODEL = "bedrock-v1"
ISSUE = "book-appointment"
FIXED_NOW = datetime(2025, 1, 1, 12, 0, 0, tzinfo=timezone.utc)


# --------------------------------------------------------------------------- #
# Fakes                                                                       #
# --------------------------------------------------------------------------- #


class StubClient:
    """Bedrock client that returns a preset candidate and records requests."""

    def __init__(self, candidate: ReasoningCandidate) -> None:
        self.candidate = candidate
        self.requests: list[ReasoningRequest] = []

    def generate(self, request: ReasoningRequest) -> ReasoningCandidate:
        self.requests.append(request)
        return self.candidate


class RecordingPublisher:
    """Captures publish_call_escalated invocations."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, Call]] = []

    def publish_call_escalated(self, tenant_id: str, call: Call) -> None:
        self.calls.append((tenant_id, call))


class RaisingClient:
    """Client that fails if ever called — proves the model is not invoked."""

    def generate(self, request: ReasoningRequest) -> ReasoningCandidate:  # pragma: no cover
        raise AssertionError("Bedrock client must not be called")


def make_validated(tenant_id: str = TENANT) -> ValidatedSe1Session:
    return ValidatedSe1Session(
        tenant_id=tenant_id,
        issuer="voice-edge-prod",
        exp=FIXED_NOW + timedelta(minutes=5),
        validated_at=FIXED_NOW,
    )


def make_session(runtime: AgentRuntime, tenant_id: str = TENANT, call_id: str = CALL):
    return runtime.start_session(
        make_validated(tenant_id), call_id=call_id, model_version=MODEL
    )


def confident_candidate(confidence: float = 0.95) -> ReasoningCandidate:
    return ReasoningCandidate(
        reply="Booked for Tuesday at 3pm.",
        confidence=confidence,
        action_type="book",
        action_payload={"slot": "tue-1500"},
    )


# --------------------------------------------------------------------------- #
# Happy path: confident, not blocked -> Action                                #
# --------------------------------------------------------------------------- #


def test_confident_unblocked_candidate_yields_action():
    rt = AgentRuntime()
    session = make_session(rt)
    client = StubClient(confident_candidate(0.9))
    publisher = RecordingPublisher()
    reasoner = BedrockReasoner(client, publisher)

    result = reasoner.reason(session, Turn(ISSUE, "I'd like to book a visit"))

    assert isinstance(result, Action)
    assert result.issue == ISSUE
    assert result.action_type == "book"
    assert result.action_payload == {"slot": "tue-1500"}
    assert result.confidence == 0.9
    assert publisher.calls == []
    assert not session.is_issue_escalated(ISSUE)


def test_request_is_scoped_to_session_tenant():
    rt = AgentRuntime()
    session = make_session(rt)
    client = StubClient(confident_candidate())
    reasoner = BedrockReasoner(client, RecordingPublisher())

    reasoner.reason(session, Turn(ISSUE, "hello"))

    assert len(client.requests) == 1
    assert client.requests[0].tenant_id == TENANT
    assert client.requests[0].issue == ISSUE


def test_confidence_exactly_at_threshold_acts():
    rt = AgentRuntime()
    session = make_session(rt)
    client = StubClient(confident_candidate(DEFAULT_CONFIDENCE_THRESHOLD))
    reasoner = BedrockReasoner(client, RecordingPublisher())

    result = reasoner.reason(session, Turn(ISSUE, "hi"))

    assert isinstance(result, Action)


# --------------------------------------------------------------------------- #
# Confidence gate (Req 9.2 / Property 12)                                     #
# --------------------------------------------------------------------------- #


def test_below_threshold_confidence_escalates():
    rt = AgentRuntime()
    session = make_session(rt)
    client = StubClient(confident_candidate(0.4))
    publisher = RecordingPublisher()
    reasoner = BedrockReasoner(client, publisher)

    result = reasoner.reason(session, Turn(ISSUE, "uh, maybe?"))

    assert isinstance(result, Escalation)
    assert result.reason == EscalationReason.LOW_CONFIDENCE
    assert result.published is True
    # Issue marked + published with the session tenant.
    assert session.is_issue_escalated(ISSUE)
    assert len(publisher.calls) == 1
    tenant_id, call = publisher.calls[0]
    assert tenant_id == TENANT
    assert call.tenant_id == TENANT
    assert call.call_id == CALL
    assert call.escalated_issue == ISSUE
    assert call.reason == EscalationReason.LOW_CONFIDENCE


@pytest.mark.parametrize("bad", [None, float("nan"), float("inf"), -0.1, 1.5])
def test_malformed_confidence_fails_closed_to_escalation(bad):
    rt = AgentRuntime()
    session = make_session(rt)
    client = StubClient(
        ReasoningCandidate(reply="x", confidence=bad, action_type="book")
    )
    reasoner = BedrockReasoner(client, RecordingPublisher())

    result = reasoner.reason(session, Turn(ISSUE, "hello"))

    assert isinstance(result, Escalation)
    assert result.reason == EscalationReason.LOW_CONFIDENCE


# --------------------------------------------------------------------------- #
# Guardrails gate (Req 9.3 / Property 12)                                     #
# --------------------------------------------------------------------------- #


def test_guardrails_block_withholds_and_escalates():
    rt = AgentRuntime()
    session = make_session(rt)
    # High confidence but blocked -> still escalates (block takes precedence).
    client = StubClient(
        ReasoningCandidate(
            reply="(withheld)",
            confidence=0.99,
            guardrail_blocked=True,
            guardrail_reason="unsafe medical advice",
            action_type="answer",
        )
    )
    publisher = RecordingPublisher()
    reasoner = BedrockReasoner(client, publisher)

    result = reasoner.reason(session, Turn(ISSUE, "should I take this medication?"))

    assert isinstance(result, Escalation)
    assert result.reason == EscalationReason.GUARDRAILS_BLOCKED
    assert "unsafe medical advice" in result.detail
    assert session.is_issue_escalated(ISSUE)
    assert len(publisher.calls) == 1


# --------------------------------------------------------------------------- #
# Escalation finality (Req 11.2 / Property 13)                                #
# --------------------------------------------------------------------------- #


def test_already_escalated_issue_is_not_re_engaged():
    rt = AgentRuntime()
    session = make_session(rt)
    session.mark_issue_escalated(ISSUE)
    publisher = RecordingPublisher()
    # Client must never be called for an already-escalated issue.
    reasoner = BedrockReasoner(RaisingClient(), publisher)

    result = reasoner.reason(session, Turn(ISSUE, "are we done yet?"))

    assert isinstance(result, Escalation)
    assert result.reason == EscalationReason.ALREADY_ESCALATED
    assert result.published is False
    # No duplicate publish for an issue already escalated.
    assert publisher.calls == []


def test_second_turn_on_escalated_issue_does_not_act():
    rt = AgentRuntime()
    session = make_session(rt)
    publisher = RecordingPublisher()
    low = BedrockReasoner(StubClient(confident_candidate(0.1)), publisher)

    first = low.reason(session, Turn(ISSUE, "hmm"))
    assert isinstance(first, Escalation)
    assert first.published is True

    # Even a now-confident candidate must not re-engage the escalated issue.
    high = BedrockReasoner(StubClient(confident_candidate(0.99)), publisher)
    second = high.reason(session, Turn(ISSUE, "ok now book it"))
    assert isinstance(second, Escalation)
    assert second.reason == EscalationReason.ALREADY_ESCALATED
    # Still only the single original publish.
    assert len(publisher.calls) == 1


def test_distinct_issue_still_handled_after_an_escalation():
    rt = AgentRuntime()
    session = make_session(rt)
    publisher = RecordingPublisher()
    reasoner = BedrockReasoner(StubClient(confident_candidate(0.95)), publisher)

    session.mark_issue_escalated("refund-dispute")
    result = reasoner.reason(session, Turn("book-appointment", "book me in"))

    assert isinstance(result, Action)
    assert publisher.calls == []


# --------------------------------------------------------------------------- #
# Tenant scoping (Req 9.4)                                                     #
# --------------------------------------------------------------------------- #


def test_matching_context_tenant_is_accepted():
    rt = AgentRuntime()
    session = make_session(rt)
    reasoner = BedrockReasoner(StubClient(confident_candidate()), RecordingPublisher())

    ctx = ReasoningContext(tenant_id=TENANT, short_term=["prior turn"])
    result = reasoner.reason(session, Turn(ISSUE, "hi"), ctx)

    assert isinstance(result, Action)


def test_cross_tenant_context_is_rejected_before_model_call():
    rt = AgentRuntime()
    session = make_session(rt)
    client = StubClient(confident_candidate())
    reasoner = BedrockReasoner(client, RecordingPublisher())

    ctx = ReasoningContext(tenant_id=OTHER_TENANT)
    with pytest.raises(ReasoningScopeError):
        reasoner.reason(session, Turn(ISSUE, "hi"), ctx)
    # Model never invoked for cross-tenant context.
    assert client.requests == []


def test_context_without_tenant_assertion_is_accepted():
    rt = AgentRuntime()
    session = make_session(rt)
    reasoner = BedrockReasoner(StubClient(confident_candidate()), RecordingPublisher())

    result = reasoner.reason(session, Turn(ISSUE, "hi"), ReasoningContext())

    assert isinstance(result, Action)


# --------------------------------------------------------------------------- #
# Input validation / construction                                             #
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("bad_issue", ["", "   "])
def test_blank_issue_is_rejected(bad_issue):
    rt = AgentRuntime()
    session = make_session(rt)
    reasoner = BedrockReasoner(StubClient(confident_candidate()), RecordingPublisher())
    with pytest.raises(InvalidTurnError):
        reasoner.reason(session, Turn(bad_issue, "hi"))


@pytest.mark.parametrize("bad_threshold", [-0.1, 1.1, float("nan"), "0.5", None, True])
def test_invalid_confidence_threshold_is_rejected(bad_threshold):
    with pytest.raises(ReasonerError):
        BedrockReasoner(
            StubClient(confident_candidate()),
            RecordingPublisher(),
            confidence_threshold=bad_threshold,
        )


def test_custom_threshold_changes_gate():
    rt = AgentRuntime()
    session = make_session(rt)
    client = StubClient(confident_candidate(0.6))
    reasoner = BedrockReasoner(client, RecordingPublisher(), confidence_threshold=0.5)

    result = reasoner.reason(session, Turn(ISSUE, "hi"))
    assert isinstance(result, Action)  # 0.6 >= 0.5
