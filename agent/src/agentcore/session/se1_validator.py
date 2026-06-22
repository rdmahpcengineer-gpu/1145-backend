"""SE-1 session validator (AC-1, assumption A3).

The backend does **not** trust the voice-edge middleware's assertion of who the
caller's tenant is. Per design assumption **A3**, the backend *independently*
validates the incoming SE-1 session and only then derives a TRUSTED
``tenantId``.

What "independently validate" means here (design §"Two trust boundaries, two
session validators" and Error Handling):

  1. **Issuer** — the session must be issued by a trusted SE-1 issuer.
  2. **Signature** — the session's signature must verify against the issuer's
     key. Verification is *injectable* so this module is unit-testable without
     live key infrastructure.
  3. **Expiry** — the session must not be expired relative to an injectable
     clock.
  4. **Tenant existence** — the claimed tenant must exist, checked via an
     injectable tenant repository.

Only a :class:`ValidatedSe1Session` produced by :meth:`Se1SessionValidator.validate`
is an acceptable tenant source for opening an AC_Runtime session (task 9.2) or
for setting the tenant on a CP-3 ``Publish_Mutation`` (Requirement 6.3; design
Requirements 3.7, 10.3, 11.3, 12.3). Invalid, expired, or forged sessions are
rejected with a typed :class:`Se1ValidationError`.

Contract note
-------------
The on-the-wire **shape** of the SE-1 token/proto is owned by the SE-1 contract
and is *imported, never authored* (see :func:`agentcore.contracts.load_se1_proto`
and the steering rule "Contracts are imported, not declared"). This module does
NOT re-declare that proto. :class:`Se1SessionClaims` is a small *structural*
model of just the fields this validator reasons about — ``issuer``, ``exp``,
``tenant_id`` and ``signature`` — populated by an adapter that decodes the
imported SE-1 message. Keeping the structural model here lets the validation
logic stay pure and testable while the byte-level decoding tracks the contract.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, Optional, Protocol, runtime_checkable

# --------------------------------------------------------------------------- #
# Structural claim model (decoded from the imported SE-1 contract)            #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Se1SessionClaims:
    """The subset of an SE-1 session this validator reasons about.

    These fields are decoded from the imported SE-1 contract message by an
    adapter; this module never decodes the proto itself. All four fields mirror
    the design's session-claim model (issuer, exp, tenantId, signature).

    Attributes:
        issuer: The party that issued the SE-1 session (e.g. the voice edge's
            signing identity). Trust in the issuer is checked separately from
            signature verification.
        tenant_id: The tenant the session *claims* to belong to. This is treated
            as untrusted input until validation succeeds.
        exp: Session expiry as a timezone-aware UTC datetime. A naive datetime is
            rejected as malformed (fail-closed) because it cannot be compared
            unambiguously against the clock.
        signature: The raw signature bytes carried by the SE-1 session, verified
            by the injected :class:`SignatureVerifier`.
        signed_payload: The exact bytes the signature covers. Optional and opaque
            to this module — provided so a real verifier can recompute/compare
            without re-encoding. Defaults to empty.
    """

    issuer: str
    tenant_id: str
    exp: datetime
    signature: bytes
    signed_payload: bytes = field(default=b"", repr=False)


@dataclass(frozen=True)
class ValidatedSe1Session:
    """A TRUSTED result of SE-1 validation.

    The only sanctioned way to obtain one is :meth:`Se1SessionValidator.validate`.
    Its :attr:`tenant_id` is the sole acceptable tenant source for an
    AC_Runtime session or a CP-3 Publish_Mutation.

    Attributes:
        tenant_id: The validated, trusted tenant id.
        issuer: The trusted issuer that signed the session.
        exp: The session expiry (timezone-aware UTC).
        validated_at: When validation succeeded (timezone-aware UTC).
    """

    tenant_id: str
    issuer: str
    exp: datetime
    validated_at: datetime


# --------------------------------------------------------------------------- #
# Injectable collaborators (keep the validator infra-free + unit-testable)    #
# --------------------------------------------------------------------------- #


@runtime_checkable
class SignatureVerifier(Protocol):
    """Verifies an SE-1 session's signature.

    Injecting this keeps the validator independent of any concrete crypto stack
    so it is unit-testable without live keys. A production implementation
    typically resolves the issuer's public key (see :class:`PublicKeyProvider`)
    and verifies :attr:`Se1SessionClaims.signature` over
    :attr:`Se1SessionClaims.signed_payload`.
    """

    def verify(self, claims: Se1SessionClaims) -> bool:
        """Return ``True`` iff the signature is valid for ``claims``."""
        ...


@runtime_checkable
class PublicKeyProvider(Protocol):
    """Resolves the verification key for a given SE-1 issuer.

    Provided as an alternative injection seam for signature verification: a
    :class:`SignatureVerifier` implementation may depend on one of these to fetch
    the issuer's public key (e.g. from a JWKS endpoint or a secrets store).
    """

    def public_key_for(self, issuer: str) -> Optional[object]:
        """Return the issuer's public key, or ``None`` if the issuer is unknown."""
        ...


@runtime_checkable
class TenantRepository(Protocol):
    """Checks tenant existence.

    Injecting this lets the validator confirm the claimed tenant is real without
    binding to live infrastructure (DynamoDB, onboarding service, etc.) in unit
    tests.
    """

    def exists(self, tenant_id: str) -> bool:
        """Return ``True`` iff a tenant with ``tenant_id`` exists."""
        ...


# --------------------------------------------------------------------------- #
# Typed errors (rejection is fail-closed and specific)                        #
# --------------------------------------------------------------------------- #


class Se1ValidationError(Exception):
    """Base class for every SE-1 session rejection.

    Catching this rejects the session before any tenant is derived or any data
    is touched (design Error Handling). Subclasses identify the failing check.
    """


class MalformedSe1SessionError(Se1ValidationError):
    """A required claim is missing, empty, or structurally invalid."""


class UntrustedSe1IssuerError(Se1ValidationError):
    """The session's issuer is not in the trusted-issuer set."""


class InvalidSe1SignatureError(Se1ValidationError):
    """The signature failed verification (forged or corrupted session)."""


class ExpiredSe1SessionError(Se1ValidationError):
    """The session is expired relative to the validator's clock."""


class UnknownTenantError(Se1ValidationError):
    """The claimed tenant does not exist."""


# --------------------------------------------------------------------------- #
# The validator                                                               #
# --------------------------------------------------------------------------- #


def _default_clock() -> datetime:
    """Current time as a timezone-aware UTC datetime."""
    return datetime.now(timezone.utc)


class Se1SessionValidator:
    """Independently validates SE-1 sessions and emits a TRUSTED tenant (A3).

    The validator owns no infrastructure: signature verification, tenant
    existence, and the clock are all injected, so it can be exercised entirely
    in-memory by unit/property tests.

    Args:
        signature_verifier: Verifies the session signature.
        tenant_repository: Checks that the claimed tenant exists.
        trusted_issuers: The set of issuers the backend trusts. If omitted or
            empty, every issuer is rejected (fail-closed) — the backend must be
            explicit about whom it trusts.
        clock: Returns "now" as a timezone-aware UTC datetime. Injectable for
            deterministic expiry tests; defaults to the real UTC clock.
    """

    def __init__(
        self,
        signature_verifier: SignatureVerifier,
        tenant_repository: TenantRepository,
        trusted_issuers: Optional[set[str] | frozenset[str]] = None,
        clock: Callable[[], datetime] = _default_clock,
    ) -> None:
        self._verifier = signature_verifier
        self._tenants = tenant_repository
        self._trusted_issuers = frozenset(trusted_issuers or ())
        self._clock = clock

    def validate(self, claims: Se1SessionClaims) -> ValidatedSe1Session:
        """Validate ``claims`` and return a TRUSTED :class:`ValidatedSe1Session`.

        Checks run fail-closed in this order: structural well-formedness, issuer
        trust, signature, expiry, then tenant existence. The first failing check
        raises its specific :class:`Se1ValidationError`; no tenant is derived
        from a session that does not pass every check.

        Raises:
            MalformedSe1SessionError: a required claim is missing/empty/invalid.
            UntrustedSe1IssuerError: the issuer is not trusted.
            InvalidSe1SignatureError: the signature does not verify.
            ExpiredSe1SessionError: the session has expired.
            UnknownTenantError: the claimed tenant does not exist.
        """
        self._check_structure(claims)
        self._check_issuer(claims)
        self._check_signature(claims)
        self._check_expiry(claims)
        self._check_tenant_exists(claims)

        return ValidatedSe1Session(
            tenant_id=claims.tenant_id,
            issuer=claims.issuer,
            exp=claims.exp,
            validated_at=self._clock(),
        )

    # -- individual checks -------------------------------------------------- #

    @staticmethod
    def _check_structure(claims: Se1SessionClaims) -> None:
        if not isinstance(claims, Se1SessionClaims):
            raise MalformedSe1SessionError(
                "expected an Se1SessionClaims decoded from the imported SE-1 "
                "contract"
            )
        if not claims.issuer or not claims.issuer.strip():
            raise MalformedSe1SessionError("SE-1 session is missing an issuer")
        if not claims.tenant_id or not claims.tenant_id.strip():
            raise MalformedSe1SessionError("SE-1 session is missing a tenant_id")
        if not isinstance(claims.signature, (bytes, bytearray)) or not claims.signature:
            raise MalformedSe1SessionError("SE-1 session is missing a signature")
        if not isinstance(claims.exp, datetime):
            raise MalformedSe1SessionError("SE-1 session exp must be a datetime")
        if claims.exp.tzinfo is None or claims.exp.utcoffset() is None:
            # A naive expiry cannot be compared unambiguously — fail closed.
            raise MalformedSe1SessionError(
                "SE-1 session exp must be timezone-aware (UTC)"
            )

    def _check_issuer(self, claims: Se1SessionClaims) -> None:
        if claims.issuer not in self._trusted_issuers:
            raise UntrustedSe1IssuerError(
                f'SE-1 issuer "{claims.issuer}" is not trusted'
            )

    def _check_signature(self, claims: Se1SessionClaims) -> None:
        if not self._verifier.verify(claims):
            raise InvalidSe1SignatureError(
                "SE-1 session signature failed verification"
            )

    def _check_expiry(self, claims: Se1SessionClaims) -> None:
        now = self._clock()
        if now >= claims.exp:
            raise ExpiredSe1SessionError(
                f"SE-1 session expired at {claims.exp.isoformat()} "
                f"(now {now.isoformat()})"
            )

    def _check_tenant_exists(self, claims: Se1SessionClaims) -> None:
        if not self._tenants.exists(claims.tenant_id):
            raise UnknownTenantError(
                f'SE-1 session claims unknown tenant "{claims.tenant_id}"'
            )


__all__ = [
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
]
