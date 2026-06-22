"""Unit tests for the SE-1 session validator (task 9.1, assumption A3).

These are example-based unit tests covering the happy path and each rejection
check. The Property 9/10 property-based tests are separate tasks (9.3/9.4) and
are not implemented here.

Validates: Requirements 6.3
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from agentcore.session.se1_validator import (
    ExpiredSe1SessionError,
    InvalidSe1SignatureError,
    MalformedSe1SessionError,
    Se1SessionClaims,
    Se1SessionValidator,
    UnknownTenantError,
    UntrustedSe1IssuerError,
    ValidatedSe1Session,
)

TRUSTED_ISSUER = "voice-edge-prod"
KNOWN_TENANT = "tenant-abc"
FIXED_NOW = datetime(2025, 1, 1, 12, 0, 0, tzinfo=timezone.utc)


# --------------------------------------------------------------------------- #
# Test doubles (injected collaborators — no live infra)                       #
# --------------------------------------------------------------------------- #


class StubVerifier:
    """Signature verifier whose result is fixed per construction."""

    def __init__(self, result: bool = True) -> None:
        self.result = result
        self.calls: list[Se1SessionClaims] = []

    def verify(self, claims: Se1SessionClaims) -> bool:
        self.calls.append(claims)
        return self.result


class StubTenantRepo:
    """Tenant repository backed by an in-memory set."""

    def __init__(self, known: set[str] | None = None) -> None:
        self.known = known if known is not None else {KNOWN_TENANT}
        self.calls: list[str] = []

    def exists(self, tenant_id: str) -> bool:
        self.calls.append(tenant_id)
        return tenant_id in self.known


def make_claims(
    *,
    issuer: str = TRUSTED_ISSUER,
    tenant_id: str = KNOWN_TENANT,
    exp: datetime | None = None,
    signature: bytes = b"sig-bytes",
    signed_payload: bytes = b"payload",
) -> Se1SessionClaims:
    return Se1SessionClaims(
        issuer=issuer,
        tenant_id=tenant_id,
        exp=exp if exp is not None else FIXED_NOW + timedelta(minutes=5),
        signature=signature,
        signed_payload=signed_payload,
    )


def make_validator(
    *,
    verifier: StubVerifier | None = None,
    tenants: StubTenantRepo | None = None,
    trusted_issuers: set[str] | None = None,
    now: datetime = FIXED_NOW,
) -> Se1SessionValidator:
    return Se1SessionValidator(
        signature_verifier=verifier or StubVerifier(True),
        tenant_repository=tenants or StubTenantRepo(),
        trusted_issuers=trusted_issuers if trusted_issuers is not None else {TRUSTED_ISSUER},
        clock=lambda: now,
    )


# --------------------------------------------------------------------------- #
# Happy path                                                                  #
# --------------------------------------------------------------------------- #


def test_valid_session_yields_trusted_tenant():
    validator = make_validator()
    result = validator.validate(make_claims())

    assert isinstance(result, ValidatedSe1Session)
    assert result.tenant_id == KNOWN_TENANT
    assert result.issuer == TRUSTED_ISSUER
    assert result.validated_at == FIXED_NOW


def test_validated_tenant_matches_claim_only_after_all_checks():
    verifier = StubVerifier(True)
    tenants = StubTenantRepo()
    validator = make_validator(verifier=verifier, tenants=tenants)

    validator.validate(make_claims())

    # Every injected collaborator was consulted.
    assert verifier.calls, "signature verifier must be consulted"
    assert tenants.calls == [KNOWN_TENANT], "tenant existence must be checked"


# --------------------------------------------------------------------------- #
# Rejection: structure / malformed                                            #
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("bad_issuer", ["", "   "])
def test_missing_issuer_is_malformed(bad_issuer):
    validator = make_validator()
    with pytest.raises(MalformedSe1SessionError):
        validator.validate(make_claims(issuer=bad_issuer))


@pytest.mark.parametrize("bad_tenant", ["", "   "])
def test_missing_tenant_is_malformed(bad_tenant):
    validator = make_validator()
    with pytest.raises(MalformedSe1SessionError):
        validator.validate(make_claims(tenant_id=bad_tenant))


def test_missing_signature_is_malformed():
    validator = make_validator()
    with pytest.raises(MalformedSe1SessionError):
        validator.validate(make_claims(signature=b""))


def test_naive_expiry_is_malformed():
    validator = make_validator()
    naive_exp = datetime(2025, 1, 1, 13, 0, 0)  # no tzinfo
    with pytest.raises(MalformedSe1SessionError):
        validator.validate(make_claims(exp=naive_exp))


# --------------------------------------------------------------------------- #
# Rejection: issuer                                                           #
# --------------------------------------------------------------------------- #


def test_untrusted_issuer_is_rejected():
    validator = make_validator()
    with pytest.raises(UntrustedSe1IssuerError):
        validator.validate(make_claims(issuer="rogue-edge"))


def test_empty_trusted_issuer_set_rejects_everything():
    validator = make_validator(trusted_issuers=set())
    with pytest.raises(UntrustedSe1IssuerError):
        validator.validate(make_claims())


# --------------------------------------------------------------------------- #
# Rejection: signature                                                        #
# --------------------------------------------------------------------------- #


def test_invalid_signature_is_rejected():
    validator = make_validator(verifier=StubVerifier(False))
    with pytest.raises(InvalidSe1SignatureError):
        validator.validate(make_claims())


def test_forged_session_does_not_reach_tenant_check():
    tenants = StubTenantRepo()
    validator = make_validator(verifier=StubVerifier(False), tenants=tenants)
    with pytest.raises(InvalidSe1SignatureError):
        validator.validate(make_claims())
    assert tenants.calls == [], "tenant must not be checked for a forged session"


# --------------------------------------------------------------------------- #
# Rejection: expiry                                                           #
# --------------------------------------------------------------------------- #


def test_expired_session_is_rejected():
    validator = make_validator(now=FIXED_NOW)
    expired = make_claims(exp=FIXED_NOW - timedelta(seconds=1))
    with pytest.raises(ExpiredSe1SessionError):
        validator.validate(expired)


def test_session_expiring_exactly_now_is_rejected():
    validator = make_validator(now=FIXED_NOW)
    at_now = make_claims(exp=FIXED_NOW)
    with pytest.raises(ExpiredSe1SessionError):
        validator.validate(at_now)


def test_session_just_before_expiry_is_accepted():
    validator = make_validator(now=FIXED_NOW)
    valid = make_claims(exp=FIXED_NOW + timedelta(seconds=1))
    result = validator.validate(valid)
    assert result.tenant_id == KNOWN_TENANT


# --------------------------------------------------------------------------- #
# Rejection: tenant existence                                                 #
# --------------------------------------------------------------------------- #


def test_unknown_tenant_is_rejected():
    validator = make_validator(tenants=StubTenantRepo(known={"other-tenant"}))
    with pytest.raises(UnknownTenantError):
        validator.validate(make_claims(tenant_id="ghost-tenant"))
