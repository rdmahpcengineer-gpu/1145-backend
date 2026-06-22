"""Unit tests for AC lead extraction (task 12.3).

Example-based tests covering the contactable gate (lead extracted when a phone
or email is present; nothing when absent), the non-booking-only rule, the
tenant sourced from the validated session, and the fan-out via the injected
``publish_lead``. The Property 6 publish-resolver property test lives on the CP-3
side (task 7.5); these are the lead-extraction example tests that complement the
optional property suite (tasks 12.6 / 24.3).

Validates: Requirements 12.1, 12.2, 12.3
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from agentcore.leads.lead_extractor import (
    ContactInfo,
    Inquiry,
    Lead,
    LeadExtractor,
    LeadScopeError,
)
from agentcore.session.runtime import AgentRuntime, Session
from agentcore.session.se1_validator import ValidatedSe1Session

TENANT = "tenant-abc"
CALL = "call-001"
MODEL = "bedrock-v1"
ISSUE = "pricing-question"
FIXED_NOW = datetime(2025, 1, 1, 12, 0, 0, tzinfo=timezone.utc)


# --------------------------------------------------------------------------- #
# Fakes / helpers                                                             #
# --------------------------------------------------------------------------- #


class RecordingLeadPublisher:
    """Captures publish_lead invocations."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, Lead]] = []

    def publish_lead(self, tenant_id: str, lead: Lead) -> None:
        self.calls.append((tenant_id, lead))


def make_validated(tenant_id: str = TENANT) -> ValidatedSe1Session:
    return ValidatedSe1Session(
        tenant_id=tenant_id,
        issuer="voice-edge-prod",
        exp=FIXED_NOW + timedelta(minutes=5),
        validated_at=FIXED_NOW,
    )


def make_session(tenant_id: str = TENANT, call_id: str = CALL) -> Session:
    rt = AgentRuntime()
    return rt.start_session(
        make_validated(tenant_id), call_id=call_id, model_version=MODEL
    )


def inquiry(
    contact: ContactInfo,
    *,
    is_booking: bool = False,
    issue: str = ISSUE,
    utterance: str = "How much for a new AC unit install?",
    notes: str = "",
) -> Inquiry:
    return Inquiry(
        issue=issue,
        utterance=utterance,
        contact=contact,
        is_booking=is_booking,
        notes=notes,
    )


# --------------------------------------------------------------------------- #
# Contactable -> lead extracted + published (Req 12.1, 12.2)                  #
# --------------------------------------------------------------------------- #


def test_contactable_phone_yields_lead_and_publishes():
    session = make_session()
    publisher = RecordingLeadPublisher()
    extractor = LeadExtractor(publisher)

    lead = extractor.extract(
        session, inquiry(ContactInfo(name="Jo", phone="(555) 123-4567"))
    )

    assert isinstance(lead, Lead)
    assert lead.issue == ISSUE
    assert lead.contact.phone == "(555) 123-4567"
    assert lead.inquiry == "How much for a new AC unit install?"
    # Published exactly once.
    assert len(publisher.calls) == 1
    tenant_id, published = publisher.calls[0]
    assert published is lead


def test_contactable_email_yields_lead():
    session = make_session()
    publisher = RecordingLeadPublisher()
    extractor = LeadExtractor(publisher)

    lead = extractor.extract(
        session, inquiry(ContactInfo(name="Sam", email="sam@example.com"))
    )

    assert isinstance(lead, Lead)
    assert lead.contact.email == "sam@example.com"
    assert len(publisher.calls) == 1


def test_lead_carries_notes_through():
    session = make_session()
    publisher = RecordingLeadPublisher()
    extractor = LeadExtractor(publisher)

    lead = extractor.extract(
        session,
        inquiry(ContactInfo(phone="5551234567"), notes="wants weekend appt"),
    )

    assert lead is not None
    assert lead.notes == "wants weekend appt"


# --------------------------------------------------------------------------- #
# Tenant sourced from the validated session (Req 12.2, 12.3)                  #
# --------------------------------------------------------------------------- #


def test_lead_tenant_comes_from_session_not_client():
    session = make_session(tenant_id=TENANT, call_id=CALL)
    publisher = RecordingLeadPublisher()
    extractor = LeadExtractor(publisher)

    lead = extractor.extract(session, inquiry(ContactInfo(email="lead@x.io")))

    assert lead is not None
    assert lead.tenant_id == TENANT
    assert lead.call_id == CALL
    tenant_id, published = publisher.calls[0]
    # publish_lead receives the session tenant as the authoritative tenant.
    assert tenant_id == TENANT
    assert published.tenant_id == TENANT


# --------------------------------------------------------------------------- #
# Non-contactable -> nothing extracted/published (Req 12.1)                   #
# --------------------------------------------------------------------------- #


def test_no_contact_info_extracts_and_publishes_nothing():
    session = make_session()
    publisher = RecordingLeadPublisher()
    extractor = LeadExtractor(publisher)

    result = extractor.extract(session, inquiry(ContactInfo()))

    assert result is None
    assert publisher.calls == []


def test_name_only_is_not_contactable():
    session = make_session()
    publisher = RecordingLeadPublisher()
    extractor = LeadExtractor(publisher)

    result = extractor.extract(session, inquiry(ContactInfo(name="Anonymous Caller")))

    assert result is None
    assert publisher.calls == []


@pytest.mark.parametrize("short_phone", ["", "   ", "call me", "123", "55-12"])
def test_unusable_phone_is_not_contactable(short_phone):
    session = make_session()
    publisher = RecordingLeadPublisher()
    extractor = LeadExtractor(publisher)

    result = extractor.extract(session, inquiry(ContactInfo(phone=short_phone)))

    assert result is None
    assert publisher.calls == []


@pytest.mark.parametrize("bad_email", ["not-an-email", "a@b", "@example.com", "x@y."])
def test_malformed_email_is_not_contactable(bad_email):
    session = make_session()
    publisher = RecordingLeadPublisher()
    extractor = LeadExtractor(publisher)

    result = extractor.extract(session, inquiry(ContactInfo(email=bad_email)))

    assert result is None
    assert publisher.calls == []


# --------------------------------------------------------------------------- #
# Non-booking-only rule                                                       #
# --------------------------------------------------------------------------- #


def test_booking_inquiry_yields_no_lead_even_if_contactable():
    session = make_session()
    publisher = RecordingLeadPublisher()
    extractor = LeadExtractor(publisher)

    result = extractor.extract(
        session,
        inquiry(ContactInfo(phone="5551234567"), is_booking=True),
    )

    assert result is None
    assert publisher.calls == []


# --------------------------------------------------------------------------- #
# Scope / input validation                                                    #
# --------------------------------------------------------------------------- #


def test_session_without_tenant_is_rejected_before_publishing():
    publisher = RecordingLeadPublisher()
    extractor = LeadExtractor(publisher)
    # A structurally-present Session with a blank tenant must be refused.
    bad = Session(call_id=CALL, tenant_id="   ", model_version=MODEL)

    with pytest.raises(LeadScopeError):
        extractor.extract(bad, inquiry(ContactInfo(email="lead@x.io")))
    assert publisher.calls == []


def test_non_session_is_rejected():
    extractor = LeadExtractor(RecordingLeadPublisher())
    with pytest.raises(LeadScopeError):
        extractor.extract(object(), inquiry(ContactInfo(email="lead@x.io")))  # type: ignore[arg-type]
