"""Unit tests for AC-3 Memory hydration (task 11.1).

Example-based unit tests covering tenant-scoped hydration of short- and
long-term context and cross-tenant isolation over a multi-tenant fixture. The
core guarantee under test: ``hydrate(session)`` returns only the session
tenant's context, by construction and via the defense-in-depth filter.

Validates: Requirements 8.1, 8.2, 8.3, 8.4
"""

from __future__ import annotations

import pytest

from agentcore.memory.memory import (
    DEFAULT_LONG_TERM_TOP_K,
    HydratedMemory,
    LongTermRecord,
    Memory,
    MemoryScopeError,
    ShortTermRecord,
    is_within_tenant,
    tenant_prefix,
)

TENANT = "tenant-abc"
OTHER_TENANT = "tenant-xyz"
CALL = "call-001"


# --------------------------------------------------------------------------- #
# Test doubles — multi-tenant in-memory stores (no infra)                     #
# --------------------------------------------------------------------------- #


class FakeShortTermStore:
    """In-memory DM-1-like store keyed ``t:<tenantId>:call:<callId>:...``.

    ``records`` maps a full Redis key to a value. ``list_call`` returns the
    entries for one tenant/call. A ``leak_extra`` list lets a test simulate a
    buggy/compromised store that returns keys outside the requested tenant
    namespace, so the defense-in-depth filter can be exercised.
    """

    def __init__(self) -> None:
        self.records: dict[str, str] = {}
        self.leak_extra: list[ShortTermRecord] = []
        self.calls: list[tuple[str, str]] = []

    def put(self, tenant_id: str, call_id: str, segment: str, value: str) -> str:
        key = f"t:{tenant_id}:call:{call_id}:{segment}"
        self.records[key] = value
        return key

    def list_call(self, tenant_id: str, call_id: str):
        self.calls.append((tenant_id, call_id))
        prefix = f"t:{tenant_id}:call:{call_id}:"
        entries = [
            ShortTermRecord(key=key, value=value)
            for key, value in self.records.items()
            if key.startswith(prefix)
        ]
        # Simulate a misbehaving store leaking foreign keys.
        entries.extend(self.leak_extra)
        return entries


class FakeLongTermStore:
    """In-memory DM-3-like embedding store with tenant-tagged rows.

    ``rows`` holds every row across all tenants. ``similarity_search`` filters to
    the requested tenant (the ``tenantId = :t`` predicate) and returns up to
    ``top_k`` rows ordered by score. ``ignore_tenant_filter`` lets a test
    simulate a store that fails to apply the predicate, exercising Memory's
    defense-in-depth row filter.
    """

    def __init__(self) -> None:
        self.rows: list[LongTermRecord] = []
        self.ignore_tenant_filter = False
        self.calls: list[tuple[str, object, int]] = []

    def add(
        self,
        tenant_id: str,
        document_id: str,
        content: str,
        score: float,
    ) -> None:
        self.rows.append(
            LongTermRecord(
                tenant_id=tenant_id,
                document_id=document_id,
                content=content,
                score=score,
            )
        )

    def similarity_search(self, tenant_id: str, query: object, *, top_k: int):
        self.calls.append((tenant_id, query, top_k))
        candidates = (
            list(self.rows)
            if self.ignore_tenant_filter
            else [r for r in self.rows if r.tenant_id == tenant_id]
        )
        candidates.sort(key=lambda r: r.score, reverse=True)
        return candidates[:top_k]


def make_session(tenant_id: str = TENANT, call_id: str = CALL):
    """A minimal object satisfying the SessionContext structural protocol."""
    return type("FakeSession", (), {"tenant_id": tenant_id, "call_id": call_id})()


def make_memory():
    return (
        FakeShortTermStore(),
        FakeLongTermStore(),
    )


# --------------------------------------------------------------------------- #
# Happy path — both stores hydrate, scoped to the session tenant              #
# --------------------------------------------------------------------------- #


def test_hydrate_returns_short_and_long_term_for_session_tenant():
    st, lt = make_memory()
    st.put(TENANT, CALL, "turn:1", "caller: my furnace is out")
    st.put(TENANT, CALL, "turn:2", "agent: when did it start?")
    lt.add(TENANT, "doc-1", "prior HVAC visit notes", score=0.9)

    memory = Memory(st, lt)
    result = memory.hydrate(make_session(), query="furnace")

    assert isinstance(result, HydratedMemory)
    assert {r.value for r in result.short_term} == {
        "caller: my furnace is out",
        "agent: when did it start?",
    }
    assert [r.document_id for r in result.long_term] == ["doc-1"]
    # Reads were scoped to the session tenant/call.
    assert st.calls == [(TENANT, CALL)]
    assert lt.calls[0][0] == TENANT


def test_hydrate_result_is_subscriptable_like_design_shape():
    st, lt = make_memory()
    st.put(TENANT, CALL, "turn:1", "hello")
    lt.add(TENANT, "doc-1", "ctx", score=0.5)
    result = Memory(st, lt).hydrate(make_session(), query="q")

    assert result["short_term"] == result.short_term
    assert result["shortTerm"] == result.short_term
    assert result["long_term"] == result.long_term
    assert result["longTerm"] == result.long_term
    with pytest.raises(KeyError):
        result["bogus"]


def test_long_term_skipped_without_query():
    st, lt = make_memory()
    st.put(TENANT, CALL, "turn:1", "hello")
    lt.add(TENANT, "doc-1", "ctx", score=0.5)

    result = Memory(st, lt).hydrate(make_session())  # no query

    assert [r.value for r in result.short_term] == ["hello"]
    assert result.long_term == ()
    assert lt.calls == [], "long-term store must not be queried without a query"


# --------------------------------------------------------------------------- #
# Isolation — multi-tenant fixture returns ONLY the session tenant's context  #
# --------------------------------------------------------------------------- #


def test_short_term_excludes_other_tenant_context():
    st, lt = make_memory()
    st.put(TENANT, CALL, "turn:1", "mine")
    st.put(OTHER_TENANT, CALL, "turn:1", "theirs")  # same callId, other tenant

    result = Memory(st, lt).hydrate(make_session(TENANT, CALL), query="q")

    values = {r.value for r in result.short_term}
    assert values == {"mine"}
    assert "theirs" not in values


def test_long_term_excludes_other_tenant_rows():
    st, lt = make_memory()
    lt.add(TENANT, "mine-1", "my context", score=0.9)
    lt.add(OTHER_TENANT, "theirs-1", "their context", score=0.99)  # higher score

    result = Memory(st, lt).hydrate(make_session(TENANT), query="q")

    assert [r.document_id for r in result.long_term] == ["mine-1"]
    assert all(r.tenant_id == TENANT for r in result.long_term)


def test_defense_in_depth_drops_leaked_short_term_keys():
    """Even if the store misbehaves and returns a foreign key, Memory drops it."""
    st, lt = make_memory()
    st.put(TENANT, CALL, "turn:1", "mine")
    # Store leaks an entry from another tenant despite the scoped request.
    st.leak_extra = [
        ShortTermRecord(key=f"t:{OTHER_TENANT}:call:{CALL}:turn:1", value="leak"),
        # A tenant prefix that is merely a string-prefix must not pass either.
        ShortTermRecord(key=f"t:{TENANT}-evil:call:{CALL}:turn:1", value="evil"),
    ]

    result = Memory(st, lt).hydrate(make_session(TENANT, CALL), query="q")

    values = {r.value for r in result.short_term}
    assert values == {"mine"}
    assert "leak" not in values and "evil" not in values


def test_defense_in_depth_drops_leaked_long_term_rows():
    """Even if the similarity search ignores its tenant predicate, Memory filters."""
    st, lt = make_memory()
    lt.add(TENANT, "mine-1", "my context", score=0.5)
    lt.add(OTHER_TENANT, "theirs-1", "their context", score=0.99)
    lt.ignore_tenant_filter = True  # store returns rows across all tenants

    result = Memory(st, lt).hydrate(make_session(TENANT), query="q")

    assert all(r.tenant_id == TENANT for r in result.long_term)
    assert [r.document_id for r in result.long_term] == ["mine-1"]


def test_hydration_isolated_across_two_tenants_same_fixture():
    st, lt = make_memory()
    st.put(TENANT, CALL, "turn:1", "abc-mine")
    st.put(OTHER_TENANT, CALL, "turn:1", "xyz-mine")
    lt.add(TENANT, "abc-doc", "abc ctx", score=0.7)
    lt.add(OTHER_TENANT, "xyz-doc", "xyz ctx", score=0.7)
    memory = Memory(st, lt)

    abc = memory.hydrate(make_session(TENANT, CALL), query="q")
    xyz = memory.hydrate(make_session(OTHER_TENANT, CALL), query="q")

    assert {r.value for r in abc.short_term} == {"abc-mine"}
    assert [r.document_id for r in abc.long_term] == ["abc-doc"]
    assert {r.value for r in xyz.short_term} == {"xyz-mine"}
    assert [r.document_id for r in xyz.long_term] == ["xyz-doc"]


# --------------------------------------------------------------------------- #
# Scope validation — fail closed before any store read                        #
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("bad_tenant", ["", "   ", "bad:id", "bad/id", None, 123])
def test_hydrate_rejects_malformed_tenant_before_reading(bad_tenant):
    st, lt = make_memory()
    with pytest.raises(MemoryScopeError):
        Memory(st, lt).hydrate(make_session(bad_tenant, CALL), query="q")
    assert st.calls == [] and lt.calls == []


@pytest.mark.parametrize("bad_call", ["", "   ", "bad:id", "bad/id", None])
def test_hydrate_rejects_malformed_call_before_reading(bad_call):
    st, lt = make_memory()
    with pytest.raises(MemoryScopeError):
        Memory(st, lt).hydrate(make_session(TENANT, bad_call), query="q")
    assert st.calls == [] and lt.calls == []


def test_memory_rejects_nonpositive_top_k_at_construction():
    st, lt = make_memory()
    with pytest.raises(MemoryScopeError):
        Memory(st, lt, long_term_top_k=0)


def test_hydrate_rejects_nonpositive_top_k_override():
    st, lt = make_memory()
    with pytest.raises(MemoryScopeError):
        Memory(st, lt).hydrate(make_session(), query="q", top_k=0)


def test_top_k_is_passed_through_to_similarity_search():
    st, lt = make_memory()
    Memory(st, lt, long_term_top_k=3).hydrate(make_session(), query="q")
    assert lt.calls[0][2] == 3

    lt.calls.clear()
    Memory(st, lt).hydrate(make_session(), query="q", top_k=5)
    assert lt.calls[0][2] == 5


def test_default_top_k_value():
    assert DEFAULT_LONG_TERM_TOP_K == 8


# --------------------------------------------------------------------------- #
# Helper coverage                                                             #
# --------------------------------------------------------------------------- #


def test_tenant_prefix_and_is_within_tenant_helpers():
    assert tenant_prefix("acme") == "t:acme:"
    assert is_within_tenant("acme", "t:acme:call:c1:f") is True
    assert is_within_tenant("acme", "t:other:call:c1:f") is False
    # A string-prefix of another tenant must not leak.
    assert is_within_tenant("acme", "t:acme-evil:call:c1:f") is False


def test_runtime_session_satisfies_protocol():
    """The real AC-1 Session works as a hydration scope."""
    from agentcore.session.runtime import Session

    st, lt = make_memory()
    st.put(TENANT, CALL, "turn:1", "real-session")
    session = Session(call_id=CALL, tenant_id=TENANT, model_version="m1")

    result = Memory(st, lt).hydrate(session, query="q")
    assert [r.value for r in result.short_term] == ["real-session"]
