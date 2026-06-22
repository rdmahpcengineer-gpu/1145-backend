"""AC-1 session layer for the 1145 AI AgentCore backend.

This package owns the two things that establish and hold tenant context for a
voice call:

  - :mod:`agentcore.session.se1_validator` (task 9.1, assumption A3) —
    *independently* validates an incoming SE-1 session and emits a TRUSTED
    ``tenantId``. This validated tenant is the ONLY acceptable tenant source for
    opening an AC_Runtime session or for setting the tenant on a CP-3
    ``Publish_Mutation``.
  - :mod:`agentcore.session.runtime` (task 9.2) — the AC-1 runtime that opens,
    holds, and releases per-call session context. It consumes the validated
    tenant produced here and never accepts a tenant from any other source.
"""

from agentcore.session.runtime import (
    DEFAULT_CALL_TTL_SECONDS,
    AgentRuntime,
    InMemorySessionStore,
    Session,
    SessionAlreadyActiveError,
    SessionError,
    SessionNotFoundError,
    SessionScopeError,
    SessionStore,
    UntrustedTenantSourceError,
    session_key,
)
from agentcore.session.se1_validator import (
    ExpiredSe1SessionError,
    InvalidSe1SignatureError,
    MalformedSe1SessionError,
    PublicKeyProvider,
    Se1SessionClaims,
    Se1SessionValidator,
    Se1ValidationError,
    SignatureVerifier,
    TenantRepository,
    UnknownTenantError,
    UntrustedSe1IssuerError,
    ValidatedSe1Session,
)

__all__ = [
    # SE-1 validator (task 9.1)
    "Se1SessionClaims",
    "ValidatedSe1Session",
    "Se1SessionValidator",
    "SignatureVerifier",
    "PublicKeyProvider",
    "TenantRepository",
    "Se1ValidationError",
    "MalformedSe1SessionError",
    "UntrustedSe1IssuerError",
    "InvalidSe1SignatureError",
    "ExpiredSe1SessionError",
    "UnknownTenantError",
    # AC-1 runtime + session context (task 9.2)
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
