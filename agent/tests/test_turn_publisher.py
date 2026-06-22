"""Unit tests for the per-turn live-state publication coordinator (task 12.2).

Example-based tests covering: turn completion fans out ``publishCallUpdate``
(Req 10.1); a finalized utterance fans out ``appendTranscript`` while an interim
one is skipped (Req 10.2); every payload's tenant is set from the validated SE-1
session regardless of what the caller put on the payload, and an unscoped
session is refused before any fan-out (Req 10.3).

Validates: Requirements 10.1, 10.2, 10.3
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from agentcore.publish.turn_publisher import (
    CallState,
    PublishScopeError,
    Speaker,
    TranscriptSegment,
    TurnPublisher,
)
from agentcore.session.runtime import AgentRuntime
from agentcore.session.se1_validator import ValidatedSe1Session

TENANT = "tenant-abc"
OTHER_TENANT = "tenant-xyz"
CALL = "call-001"
MODEL = "bedrock-v1"
FIXED_NOW = datetime(2025, 1, 1, 12, 0, 0, tzinfo=timezone.utc)


# --------------------------------------------------------------------------- #
# Fakes                                                                       #
# --------------------------------------------------------------------------- #


class RecordingPublisher:
    """Captures publish_call_update / append_transcript invocations."""

    def __init__(self) -> None:
        self.updates: list[tuple[str, CallState]] = []
        self.segments: list[tuple[str, TranscriptSegment]] = []

    def publish_call_update(self, tenant_id: str, call: CallState) -> None:
        self.updates.append((tenant_id, call))

    def append_transcript(self, tenant_id: str, segment: TranscriptSegment) -> None:
        self.segments.append((tenant_id, segment))


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


# --------------------------------------------------------------------------- #
# publish_call_update — turn completion (Req 10.1)                            #
# --------------------------------------------------------------------------- #


def test_turn_completion_publishes_call_update():
    rt = AgentRuntime()
    session = make_session(rt)
    pub = RecordingPublisher()
    coordinator = TurnPublisher(pub)

    state = CallState(call_id=CALL, tenant_id=TENANT, status="in_progress", turn=1)
    returned = coordinator.publish_call_update(session, state)

    assert len(pub.updates) == 1
    tenant_id, call = pub.updates[0]
    assert tenant_id == TENANT
    assert call.tenant_id == TENANT
    assert call.call_id == CALL
    assert call.status == "in_progress"
    assert returned is call


def test_call_update_carries_sentiment_field():
    rt = AgentRuntime()
    session = make_session(rt)
    pub = RecordingPublisher()
    coordinator = TurnPublisher(pub)

    coordinator.publish_call_update(
        session, CallState(call_id=CALL, tenant_id=TENANT, sentiment=0.42)
    )

    assert pub.updates[0][1].sentiment == 0.42


# --------------------------------------------------------------------------- #
# append_transcript — finalized utterance (Req 10.2)                          #
# --------------------------------------------------------------------------- #


def test_finalized_utterance_is_appended():
    rt = AgentRuntime()
    session = make_session(rt)
    pub = RecordingPublisher()
    coordinator = TurnPublisher(pub)

    seg = TranscriptSegment(
        call_id=CALL, tenant_id=TENANT, speaker=Speaker.CALLER, text="hi there", turn=1
    )
    returned = coordinator.append_transcript(session, seg)

    assert len(pub.segments) == 1
    tenant_id, published = pub.segments[0]
    assert tenant_id == TENANT
    assert published.text == "hi there"
    assert published.speaker == Speaker.CALLER
    assert returned is published


def test_interim_utterance_is_not_appended():
    rt = AgentRuntime()
    session = make_session(rt)
    pub = RecordingPublisher()
    coordinator = TurnPublisher(pub)

    seg = TranscriptSegment(
        call_id=CALL,
        tenant_id=TENANT,
        speaker=Speaker.AGENT,
        text="(partial...)",
        final=False,
    )
    result = coordinator.append_transcript(session, seg)

    assert result is None
    assert pub.segments == []


# --------------------------------------------------------------------------- #
# Tenant set from the validated SE-1 session (Req 10.3)                       #
# --------------------------------------------------------------------------- #


def test_call_update_tenant_is_forced_from_session():
    rt = AgentRuntime()
    session = make_session(rt, tenant_id=TENANT)
    pub = RecordingPublisher()
    coordinator = TurnPublisher(pub)

    # Caller tries to spoof a different tenant on the payload.
    spoofed = CallState(call_id=CALL, tenant_id=OTHER_TENANT, status="in_progress")
    coordinator.publish_call_update(session, spoofed)

    tenant_id, call = pub.updates[0]
    assert tenant_id == TENANT
    assert call.tenant_id == TENANT  # overwritten from the validated session


def test_transcript_tenant_is_forced_from_session():
    rt = AgentRuntime()
    session = make_session(rt, tenant_id=TENANT)
    pub = RecordingPublisher()
    coordinator = TurnPublisher(pub)

    spoofed = TranscriptSegment(
        call_id=CALL, tenant_id=OTHER_TENANT, speaker=Speaker.AGENT, text="ok"
    )
    coordinator.append_transcript(session, spoofed)

    tenant_id, seg = pub.segments[0]
    assert tenant_id == TENANT
    assert seg.tenant_id == TENANT


def test_publish_requires_a_real_session():
    pub = RecordingPublisher()
    coordinator = TurnPublisher(pub)

    # A bare tenant string is not a validated session — must be refused.
    with pytest.raises(PublishScopeError):
        coordinator.publish_call_update(TENANT, CallState(call_id=CALL, tenant_id=TENANT))  # type: ignore[arg-type]
    assert pub.updates == []


# --------------------------------------------------------------------------- #
# publish_turn — combined per-turn fan-out                                    #
# --------------------------------------------------------------------------- #


def test_publish_turn_fans_out_update_then_finalized_segments():
    rt = AgentRuntime()
    session = make_session(rt)
    pub = RecordingPublisher()
    coordinator = TurnPublisher(pub)

    call = CallState(call_id=CALL, tenant_id=TENANT, status="in_progress", turn=2)
    segments = [
        TranscriptSegment(call_id=CALL, tenant_id=TENANT, speaker=Speaker.CALLER, text="book me", turn=2),
        TranscriptSegment(call_id=CALL, tenant_id=TENANT, speaker=Speaker.AGENT, text="...", final=False),
        TranscriptSegment(call_id=CALL, tenant_id=TENANT, speaker=Speaker.AGENT, text="Booked.", turn=2),
    ]

    coordinator.publish_turn(session, call, segments)

    # One call update, two finalized segments (interim skipped).
    assert len(pub.updates) == 1
    assert [s.text for _, s in pub.segments] == ["book me", "Booked."]
    assert all(t == TENANT for t, _ in pub.updates)
    assert all(t == TENANT for t, _ in pub.segments)


def test_publish_turn_with_no_segments_only_updates():
    rt = AgentRuntime()
    session = make_session(rt)
    pub = RecordingPublisher()
    coordinator = TurnPublisher(pub)

    coordinator.publish_turn(session, CallState(call_id=CALL, tenant_id=TENANT))

    assert len(pub.updates) == 1
    assert pub.segments == []


def test_publish_turn_unscoped_session_publishes_nothing():
    rt = AgentRuntime()
    session = make_session(rt)
    # Corrupt the tenant scope after creation to simulate a missing scope.
    object.__setattr__(session, "tenant_id", "")
    pub = RecordingPublisher()
    coordinator = TurnPublisher(pub)

    with pytest.raises(PublishScopeError):
        coordinator.publish_turn(
            session,
            CallState(call_id=CALL, tenant_id=TENANT),
            [TranscriptSegment(call_id=CALL, tenant_id=TENANT, speaker=Speaker.CALLER, text="hi")],
        )
    assert pub.updates == []
    assert pub.segments == []


# --------------------------------------------------------------------------- #
# Type guards                                                                 #
# --------------------------------------------------------------------------- #


def test_wrong_payload_types_are_rejected():
    rt = AgentRuntime()
    session = make_session(rt)
    coordinator = TurnPublisher(RecordingPublisher())

    with pytest.raises(TypeError):
        coordinator.publish_call_update(session, object())  # type: ignore[arg-type]
    with pytest.raises(TypeError):
        coordinator.append_transcript(session, object())  # type: ignore[arg-type]
