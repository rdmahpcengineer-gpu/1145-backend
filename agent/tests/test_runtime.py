"""Unit tests for the AC-1 runtime and session context (task 9.2).

Example-based unit tests covering session open/turn/release, the
tenant-from-validated-session rule, and TTL- and delete-based release. The
Property 9/10 property-based tests are separate tasks (9.3/9.4) and are not
implemented here.

Validates: Requirements 6.1, 6.2, 6.4
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from agentcore.session.runtime import (
    DEFAULT_CALL_TTL_SECONDS,
    AgentRuntime,
    InMemorySessionStore,
    Session,
    SessionAlreadyActiveError,
    SessionNotFoundError,
    SessionScopeError,
    UntrustedTenantSourceError,
    session_key,
)
from agentcore.session.se1_validator import ValidatedSe1Session

TENANT = "tenant-abc"
OTHER_TENANT = "tenant-xyz"
CALL = "call-001"
MODEL = "bedrock-v1"
FIXED_NOW = datetime(2025, 1, 1, 12, 0, 0, tzinfo=timezone.utc)


# --------------------------------------------------------------------------- #
# Helpers / fixtures                                                          #
# --------------------------------------------------------------------------- #


class FakeClock:
    """Manually advanceable monotonic clock for deterministic TTL tests."""

    def __init__(self, start: float = 0.0) -> None:
        self.t = start

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


def make_validated(tenant_id: str = TENANT) -> ValidatedSe1Session:
    return ValidatedSe1Session(
        tenant_id=tenant_id,
        issuer="voice-edge-prod",
        exp=FIXED_NOW + timedelta(minutes=5),
        validated_at=FIXED_NOW,
    )


# --------------------------------------------------------------------------- #
# start_session — open a call session                                         #
# --------------------------------------------------------------------------- #


def test_start_session_holds_validated_tenant():
    rt = AgentRuntime()
    session = rt.start_session(make_validated(), call_id=CALL, model_version=MODEL)

    assert isinstance(session, Session)
    assert session.call_id == CALL
    assert session.tenant_id == TENANT
    assert session.model_version == MODEL
    assert session.escalated_issues == set()
    assert rt.is_active(CALL)


def test_tenant_comes_only_from_validated_session_type():
    rt = AgentRuntime()
    # A plain object that merely *looks* like it has a tenant must be refused.
    fake = type("FakeClaim", (), {"tenant_id": "attacker"})()
    with pytest.raises(UntrustedTenantSourceError):
        rt.start_session(fake, call_id=CALL, model_version=MODEL)
    assert not rt.is_active(CALL)


def test_start_session_rejects_blank_model_version():
    rt = AgentRuntime()
    with pytest.raises(SessionScopeError):
        rt.start_session(make_validated(), call_id=CALL, model_version="  ")


@pytest.mark.parametrize("bad_call", ["", "  ", "bad:id", "bad/id"])
def test_start_session_rejects_malformed_call_id(bad_call):
    rt = AgentRuntime()
    with pytest.raises(SessionScopeError):
        rt.start_session(make_validated(), call_id=bad_call, model_version=MODEL)


def test_duplicate_start_is_rejected():
    rt = AgentRuntime()
    rt.start_session(make_validated(), call_id=CALL, model_version=MODEL)
    with pytest.raises(SessionAlreadyActiveError):
        rt.start_session(make_validated(), call_id=CALL, model_version=MODEL)


def test_session_is_stored_under_tenant_call_namespace():
    store = InMemorySessionStore()
    rt = AgentRuntime(store)
    rt.start_session(make_validated(), call_id=CALL, model_version=MODEL)

    key = session_key(TENANT, CALL)
    assert key == f"t:{TENANT}:call:{CALL}:session"
    assert store.get(key) is not None


# --------------------------------------------------------------------------- #
# with_session — associate a turn with the session/tenant                     #
# --------------------------------------------------------------------------- #


def test_with_session_associates_turn_with_session_tenant():
    rt = AgentRuntime()
    rt.start_session(make_validated(), call_id=CALL, model_version=MODEL)

    seen: list[str] = []
    result = rt.with_session(CALL, lambda s: (seen.append(s.tenant_id), s.tenant_id)[1])

    assert seen == [TENANT]
    assert result == TENANT


def test_with_session_persists_escalated_issue_mutation():
    rt = AgentRuntime()
    rt.start_session(make_validated(), call_id=CALL, model_version=MODEL)

    rt.with_session(CALL, lambda s: s.mark_issue_escalated("refund-dispute"))

    # The mutation survives into the next turn's view of the session.
    assert rt.with_session(CALL, lambda s: s.is_issue_escalated("refund-dispute"))
    assert rt.get_session(CALL).escalated_issues == {"refund-dispute"}


def test_with_session_on_unknown_call_raises():
    rt = AgentRuntime()
    with pytest.raises(SessionNotFoundError):
        rt.with_session("ghost-call", lambda s: s.tenant_id)


def test_turns_across_many_calls_keep_their_own_tenant():
    rt = AgentRuntime()
    rt.start_session(make_validated(TENANT), call_id="c1", model_version=MODEL)
    rt.start_session(make_validated(OTHER_TENANT), call_id="c2", model_version=MODEL)

    assert rt.with_session("c1", lambda s: s.tenant_id) == TENANT
    assert rt.with_session("c2", lambda s: s.tenant_id) == OTHER_TENANT


# --------------------------------------------------------------------------- #
# end_session — release context (explicit delete)                             #
# --------------------------------------------------------------------------- #


def test_end_session_releases_context():
    store = InMemorySessionStore()
    rt = AgentRuntime(store)
    rt.start_session(make_validated(), call_id=CALL, model_version=MODEL)

    rt.end_session(CALL)

    assert not rt.is_active(CALL)
    assert store.get(session_key(TENANT, CALL)) is None
    with pytest.raises(SessionNotFoundError):
        rt.get_session(CALL)
    with pytest.raises(SessionNotFoundError):
        rt.with_session(CALL, lambda s: s.tenant_id)


def test_end_session_is_idempotent():
    rt = AgentRuntime()
    rt.start_session(make_validated(), call_id=CALL, model_version=MODEL)
    rt.end_session(CALL)
    # Ending again (or an unknown call) must not raise.
    rt.end_session(CALL)
    rt.end_session("never-started")


# --------------------------------------------------------------------------- #
# TTL-based release (Redis TTL path)                                          #
# --------------------------------------------------------------------------- #


def test_session_expires_via_call_lifetime_ttl():
    clock = FakeClock()
    store = InMemorySessionStore(clock=clock)
    rt = AgentRuntime(store, ttl_seconds=60)
    rt.start_session(make_validated(), call_id=CALL, model_version=MODEL)

    assert rt.is_active(CALL)
    clock.advance(61)  # past the TTL
    assert not rt.is_active(CALL)
    with pytest.raises(SessionNotFoundError):
        rt.get_session(CALL)


def test_with_session_refreshes_ttl_mid_call():
    clock = FakeClock()
    store = InMemorySessionStore(clock=clock)
    rt = AgentRuntime(store, ttl_seconds=60)
    rt.start_session(make_validated(), call_id=CALL, model_version=MODEL)

    clock.advance(40)
    rt.with_session(CALL, lambda s: s.tenant_id)  # refresh
    clock.advance(40)  # 80s since start, but only 40s since refresh
    assert rt.is_active(CALL)


def test_default_ttl_is_one_hour():
    assert DEFAULT_CALL_TTL_SECONDS == 3600


def test_runtime_rejects_nonpositive_ttl():
    with pytest.raises(SessionScopeError):
        AgentRuntime(ttl_seconds=0)
