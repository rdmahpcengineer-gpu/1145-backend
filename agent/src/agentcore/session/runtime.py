"""AC-1 runtime and session context (task 9.2).

The AC-1 Runtime establishes and holds **tenant + session context for the
duration of a call** (design.md "AC-1 — Runtime and session context";
Requirements 6.1, 6.2, 6.4; steering ``bedrock-agentcore.md``).

What this module owns
---------------------
On ``CallStart`` over a *validated* SE-1 session it creates a
:class:`Session` holding ``{ callId, tenantId, escalatedIssues, modelVersion }``
and keeps it for the call's lifetime. Every turn is run *through* that session
(:meth:`AgentRuntime.with_session`) so the turn is always associated with the
session and its ``tenantId``. On ``CallEnd`` the context is released
(:meth:`AgentRuntime.end_session`).

The non-negotiable tenant rule
------------------------------
``tenantId`` enters a session **only** from a :class:`ValidatedSe1Session`
produced by the SE-1 validator (task 9.1, assumption A3) — never from a
client-supplied field (Requirement 6.3; steering ``multi-tenant-platform.md``).
:meth:`AgentRuntime.start_session` therefore accepts the *trusted* type and
refuses anything else.

Injectable, infra-free store
----------------------------
Session persistence and release are modeled behind a small Redis-like
:class:`SessionStore` protocol (``set``/``get``/``delete`` with a TTL), so the
runtime is unit-testable without any live Redis. The session is stored under the
DM-1 tenant/call key namespace ``t:<tenantId>:call:<callId>:session`` (the same
``t:<tenantId>:call:<callId>:...`` convention enforced on the TypeScript side in
``data/redis/keys``) so a session entry can never escape its tenant's keyspace.
Release uses **both** mechanisms the design calls for: a call-lifetime TTL *and*
an explicit delete on ``CallEnd``. A reference :class:`InMemorySessionStore`
(TTL honored against an injectable clock) is provided as the default backend and
for tests; a thin adapter over the real ElastiCache Redis client is injected in
production.

Note on ``callId``/``modelVersion``: like the validator's structural claim
model, the byte-level decode of the SE-1 turn envelope is owned by the imported
SE-1 contract and is *not* re-authored here. The runtime entrypoint passes the
call id and the active model version in; ``tenantId`` is still taken solely from
the validated session.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from typing import Callable, Optional, Protocol, Sequence, TypeVar, runtime_checkable

from agentcore.session.se1_validator import ValidatedSe1Session

T = TypeVar("T")

#: Default call-lifetime TTL (seconds) for a session entry. Sized generously
#: above a typical call so the context survives the whole call but is reclaimed
#: automatically afterwards even if ``end_session`` is never reached. Mirrors
#: ``DEFAULT_CALL_TTL_SECONDS`` on the TypeScript DM-1 store.
DEFAULT_CALL_TTL_SECONDS = 3600  # 1 hour

#: Root namespace segment for every session key: ``t``.
TENANT_NAMESPACE = "t"
#: Segment marking a per-call sub-namespace: ``call``.
CALL_NAMESPACE = "call"
#: Field segment addressing the session record within a call's namespace.
SESSION_FIELD = "session"
#: Separator between key segments.
KEY_SEPARATOR = ":"

#: Allowed shape of a ``tenantId`` / ``callId`` embedded in a key: 1–128 chars,
#: must start alphanumeric, only ``_``/``-`` otherwise — notably NO ``:`` so an
#: id can never inject an extra key segment and escape its namespace. Mirrors the
#: ID constraint used by the DM-1 key builder and DM-2 query builder.
_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")


# --------------------------------------------------------------------------- #
# Errors                                                                      #
# --------------------------------------------------------------------------- #


class SessionError(Exception):
    """Base class for AC-1 runtime/session failures."""


class SessionScopeError(SessionError):
    """A tenant/call scope is missing or malformed.

    Raised BEFORE any store command is issued, so an unscoped or malformed
    session access can never reach the backing store.
    """


class UntrustedTenantSourceError(SessionError):
    """A session was asked to open from something other than a validated SE-1 session.

    ``tenantId`` may only originate from a :class:`ValidatedSe1Session`
    (Requirement 6.3). Passing a raw/client-supplied value is refused.
    """


class SessionAlreadyActiveError(SessionError):
    """``start_session`` was called for a call that already has an active session."""


class SessionNotFoundError(SessionError):
    """No active session resolves for the given ``callId``.

    Raised after the session was never started, has been released by
    ``end_session``, or has expired via its call-lifetime TTL.
    """


# --------------------------------------------------------------------------- #
# Key construction (local, mirrors data/redis/keys)                           #
# --------------------------------------------------------------------------- #


def _is_valid_id(value: object) -> bool:
    """True iff ``value`` is a string safe to embed in a session key."""
    return isinstance(value, str) and bool(_ID_PATTERN.match(value))


def _assert_valid_tenant_id(tenant_id: object) -> None:
    if not _is_valid_id(tenant_id):
        raise SessionScopeError(
            f"A valid tenant scope is required: invalid tenantId {tenant_id!r}."
        )


def _assert_valid_call_id(call_id: object) -> None:
    if not _is_valid_id(call_id):
        raise SessionScopeError(
            f"A valid call scope is required: invalid callId {call_id!r}."
        )


def session_key(tenant_id: str, call_id: str) -> str:
    """Build the session key ``t:<tenantId>:call:<callId>:session``.

    Raises:
        SessionScopeError: if the tenant or call id is missing/malformed.
    """
    _assert_valid_tenant_id(tenant_id)
    _assert_valid_call_id(call_id)
    return KEY_SEPARATOR.join(
        (TENANT_NAMESPACE, tenant_id, CALL_NAMESPACE, call_id, SESSION_FIELD)
    )


# --------------------------------------------------------------------------- #
# Session model                                                               #
# --------------------------------------------------------------------------- #


@dataclass
class Session:
    """The AC-1 call session (design "Session model").

    Held for the duration of one call. ``tenant_id`` is always the validated
    SE-1 tenant; nothing in the turn-processing path may overwrite it.

    Attributes:
        call_id: The call this session belongs to.
        tenant_id: The validated, trusted tenant id (from the SE-1 validator).
        escalated_issues: Issues already escalated on this call. Once an issue is
            here, AC-4 must not re-engage it (Property 13, enforced by task 12.x;
            the runtime owns the storage of this set).
        model_version: The reasoner model version active for this call.
    """

    call_id: str
    tenant_id: str
    model_version: str
    escalated_issues: set[str] = field(default_factory=set)

    def mark_issue_escalated(self, issue: str) -> None:
        """Record ``issue`` as escalated for this call."""
        if not isinstance(issue, str) or not issue.strip():
            raise SessionScopeError("an escalated issue must be a non-empty string")
        self.escalated_issues.add(issue)

    def is_issue_escalated(self, issue: str) -> bool:
        """Return ``True`` iff ``issue`` has already been escalated on this call."""
        return issue in self.escalated_issues


# --------------------------------------------------------------------------- #
# Injectable Redis-like store                                                 #
# --------------------------------------------------------------------------- #


@runtime_checkable
class SessionStore(Protocol):
    """Minimal Redis-like surface the runtime needs (decoupled from any driver).

    A production adapter wraps the ElastiCache Redis client; tests use
    :class:`InMemorySessionStore`. Implementations MUST honor ``ttl_seconds`` so
    that an entry disappears after its call-lifetime TTL even when
    ``end_session`` is never reached.
    """

    def set(self, key: str, value: str, ttl_seconds: int) -> None:
        """Set ``key`` to ``value`` with an expiry of ``ttl_seconds``."""
        ...

    def get(self, key: str) -> Optional[str]:
        """Return the value for ``key``, or ``None`` if absent/expired."""
        ...

    def delete(self, keys: Sequence[str]) -> int:
        """Delete the given keys; return the number removed."""
        ...


class InMemorySessionStore:
    """In-process Redis-like store with TTL, for the default backend and tests.

    Expiry is evaluated against an injectable monotonic ``clock`` so tests can
    advance time deterministically without sleeping.
    """

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        # key -> (value, expires_at_monotonic)
        self._entries: dict[str, tuple[str, float]] = {}

    def set(self, key: str, value: str, ttl_seconds: int) -> None:
        if not isinstance(ttl_seconds, int) or ttl_seconds <= 0:
            raise SessionScopeError(
                f"a call-lifetime TTL must be a positive integer of seconds, "
                f"got {ttl_seconds!r}."
            )
        self._entries[key] = (value, self._clock() + ttl_seconds)

    def get(self, key: str) -> Optional[str]:
        entry = self._entries.get(key)
        if entry is None:
            return None
        value, expires_at = entry
        if self._clock() >= expires_at:
            # Expired by TTL — reclaim and report absent.
            self._entries.pop(key, None)
            return None
        return value

    def delete(self, keys: Sequence[str]) -> int:
        removed = 0
        for key in keys:
            if self._entries.pop(key, None) is not None:
                removed += 1
        return removed


# --------------------------------------------------------------------------- #
# Serialization                                                               #
# --------------------------------------------------------------------------- #


def _serialize(session: Session) -> str:
    """Serialize a session to the JSON payload stored under its key."""
    return json.dumps(
        {
            "callId": session.call_id,
            "tenantId": session.tenant_id,
            "modelVersion": session.model_version,
            "escalatedIssues": sorted(session.escalated_issues),
        },
        separators=(",", ":"),
        sort_keys=True,
    )


# --------------------------------------------------------------------------- #
# The runtime                                                                 #
# --------------------------------------------------------------------------- #


class AgentRuntime:
    """AC-1 runtime: opens, holds, and releases per-call session context.

    The runtime keeps an in-memory index of active sessions (the working set for
    turn processing) and mirrors each one into the injectable
    :class:`SessionStore` with a call-lifetime TTL. The store is what makes
    release real: a session is considered active only while its store entry
    lives, so both an explicit ``end_session`` *and* TTL expiry cause subsequent
    lookups to fail (Requirement 6.4, Property 10).

    Args:
        store: The Redis-like backing store. Defaults to a fresh
            :class:`InMemorySessionStore`.
        ttl_seconds: Call-lifetime TTL applied to every session write. Refreshed
            on each ``with_session`` so an active call's context does not expire
            mid-call.
    """

    def __init__(
        self,
        store: Optional[SessionStore] = None,
        *,
        ttl_seconds: int = DEFAULT_CALL_TTL_SECONDS,
    ) -> None:
        if not isinstance(ttl_seconds, int) or ttl_seconds <= 0:
            raise SessionScopeError(
                f"session TTL must be a positive integer of seconds, "
                f"got {ttl_seconds!r}."
            )
        self._store: SessionStore = store if store is not None else InMemorySessionStore()
        self._ttl = ttl_seconds
        # call_id -> live Session (authoritative working set for this runtime).
        self._active: dict[str, Session] = {}

    # -- lifecycle ---------------------------------------------------------- #

    def start_session(
        self,
        validated: ValidatedSe1Session,
        *,
        call_id: str,
        model_version: str,
    ) -> Session:
        """Open a session on ``CallStart`` over a validated SE-1 session.

        The ``tenantId`` is taken **only** from ``validated`` (Requirement 6.3);
        passing anything other than a :class:`ValidatedSe1Session` is refused.
        The session is written to the store with a call-lifetime TTL and cached
        as the live working set for the call.

        Args:
            validated: The trusted SE-1 session from the validator (task 9.1).
            call_id: The call this session is for (from the SE-1 turn envelope).
            model_version: The reasoner model version active for this call.

        Returns:
            The created :class:`Session`.

        Raises:
            UntrustedTenantSourceError: ``validated`` is not a validated SE-1
                session.
            SessionScopeError: ``call_id`` is missing/malformed or
                ``model_version`` is empty.
            SessionAlreadyActiveError: a session for ``call_id`` is already open.
        """
        if not isinstance(validated, ValidatedSe1Session):
            raise UntrustedTenantSourceError(
                "a session may only be opened from a ValidatedSe1Session; "
                "tenantId must never come from a client-supplied field"
            )
        _assert_valid_call_id(call_id)
        if not isinstance(model_version, str) or not model_version.strip():
            raise SessionScopeError("model_version must be a non-empty string")

        # Build the key now so a malformed tenant fails before any state change.
        key = session_key(validated.tenant_id, call_id)

        if call_id in self._active or self._store.get(key) is not None:
            raise SessionAlreadyActiveError(
                f"a session for call {call_id!r} is already active"
            )

        session = Session(
            call_id=call_id,
            tenant_id=validated.tenant_id,
            model_version=model_version,
        )
        self._store.set(key, _serialize(session), self._ttl)
        self._active[call_id] = session
        return session

    def with_session(self, call_id: str, fn: Callable[[Session], T]) -> T:
        """Run a turn within the call's session and persist any mutation.

        Resolves the active session for ``call_id``, invokes ``fn(session)`` so
        the turn is associated with the session and its ``tenantId``
        (Requirements 6.1, 6.2), then writes the (possibly mutated) session back
        with a refreshed TTL and returns ``fn``'s result.

        Raises:
            SessionNotFoundError: no active session resolves for ``call_id``.
        """
        session = self._resolve(call_id)
        result = fn(session)
        # Persist mutations (e.g. a newly escalated issue) and refresh the TTL so
        # an active call's context does not expire mid-call.
        self._store.set(
            session_key(session.tenant_id, session.call_id),
            _serialize(session),
            self._ttl,
        )
        return result

    def get_session(self, call_id: str) -> Session:
        """Return the active session for ``call_id`` without mutating it.

        Raises:
            SessionNotFoundError: no active session resolves for ``call_id``.
        """
        return self._resolve(call_id)

    def is_active(self, call_id: str) -> bool:
        """Return ``True`` iff an active session resolves for ``call_id``."""
        try:
            self._resolve(call_id)
        except SessionNotFoundError:
            return False
        return True

    def end_session(self, call_id: str) -> None:
        """Release the session context on ``CallEnd`` (Requirement 6.4).

        Removes the session from the in-memory working set and explicitly deletes
        its store entry (complementing the call-lifetime TTL). After this, no
        subsequent lookup resolves the call (Property 10). Idempotent: ending an
        unknown/already-ended call is a no-op.
        """
        session = self._active.pop(call_id, None)
        if session is None:
            return
        self._store.delete([session_key(session.tenant_id, session.call_id)])

    # -- internals ---------------------------------------------------------- #

    def _resolve(self, call_id: str) -> Session:
        """Resolve the live session for ``call_id``, honoring store TTL/delete.

        The in-memory map is the working set, but the store is the source of
        truth for liveness: if the store entry is gone (explicitly deleted or
        TTL-expired), the session is treated as released and evicted from memory.
        """
        session = self._active.get(call_id)
        if session is None:
            raise SessionNotFoundError(f"no active session for call {call_id!r}")
        key = session_key(session.tenant_id, session.call_id)
        if self._store.get(key) is None:
            # Released by TTL or an out-of-band delete — drop the stale cache.
            self._active.pop(call_id, None)
            raise SessionNotFoundError(
                f"session for call {call_id!r} has been released"
            )
        return session


__all__ = [
    "DEFAULT_CALL_TTL_SECONDS",
    "Session",
    "SessionStore",
    "InMemorySessionStore",
    "AgentRuntime",
    "session_key",
    "SessionError",
    "SessionScopeError",
    "UntrustedTenantSourceError",
    "SessionAlreadyActiveError",
    "SessionNotFoundError",
]
