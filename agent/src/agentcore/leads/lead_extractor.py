"""AC lead extraction → CP-3 ``publishLead`` (task 12.3).

When the AI agent handles a **non-booking inquiry** that yields **contactable
lead information**, the backend captures a :class:`Lead` and fans it out to the
operator dashboard over CP-3's ``publishLead`` mutation (design.md "Lead
extraction from non-booking inquiries → ``publishLead``"; Requirements 12.1,
12.2, 12.3; steering ``bedrock-agentcore.md``).

What this module owns
---------------------
:meth:`LeadExtractor.extract` ``(session, inquiry)``:

  1. **Tenant scoping (Req 12.3).** The tenant on the published lead is taken
     **only** from the AC-1 session (``session.tenant_id``), which itself holds
     the validated SE-1 tenant. A client-supplied tenant value never seeds a
     lead. A session missing a tenant scope is refused before anything is
     published.
  2. **Non-booking only.** Leads are captured from conversations that did *not*
     result in a booking. A booking inquiry yields no lead (the booking flow,
     WF-2, owns that outcome) — :meth:`extract` returns ``None`` and publishes
     nothing.
  3. **Contactable gate (Req 12.1).** A lead is only extracted when the inquiry
     carries a way to reach the caller back — a phone number or an email. With
     no contactable info, :meth:`extract` extracts and publishes nothing and
     returns ``None``.
  4. **Extract + publish (Req 12.1, 12.2).** When the inquiry is non-booking and
     contactable, a :class:`Lead` is built (tenant + call from the session) and
     handed to the injected publisher's ``publish_lead(tenant_id, lead)``.

Self-contained + injectable
---------------------------
This task runs concurrently with the per-turn live-publication work (task 12.2)
under ``agent/src/agentcore/publish/**`` and must not touch it, nor the AC-4
reasoner. So the CP-3 fan-out is modeled here behind a small local
:class:`LeadPublisher` protocol exposing exactly ``publish_lead(tenant_id,
lead)``. A production wiring injects the real CP-3 ``publishLead`` adapter (which
sets the tenant from the validated SE-1 session per the publish-resolver
contract, design Req 3.7); tests inject a recording fake. The on-the-wire shape
of ``publishLead``'s argument is owned by the imported CP-3 SDL and is mapped by
the publish adapter — :class:`Lead` is the small structural payload the Python
extractor hands across that boundary, not a re-authored contract type.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional, Protocol, runtime_checkable

from agentcore.session.runtime import Session

#: Minimum count of digits for a value to be considered a usable phone number.
#: Short fragments ("call 5") are not a contactable number.
_MIN_PHONE_DIGITS = 7

#: Structural email check: ``local@domain.tld``. Deliberately conservative — it
#: gates "is this contactable", not RFC-5322 conformance.
_EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


# --------------------------------------------------------------------------- #
# Errors                                                                      #
# --------------------------------------------------------------------------- #


class LeadError(Exception):
    """Base class for lead-extraction failures."""


class LeadScopeError(LeadError):
    """The session is missing a tenant scope.

    Raised BEFORE anything is published so a lead can never be fanned out
    without a validated tenant (Requirement 12.3).
    """


# --------------------------------------------------------------------------- #
# Contact + inquiry inputs                                                    #
# --------------------------------------------------------------------------- #


def _clean(value: Optional[str]) -> str:
    """Return a trimmed string, or ``""`` for ``None``/non-strings."""
    return value.strip() if isinstance(value, str) else ""


@dataclass(frozen=True)
class ContactInfo:
    """How the caller can be reached back, captured from the conversation.

    "Contactable" means there is at least one usable channel to follow up on —
    a phone number or an email. A name on its own is *not* contactable: without
    a phone or email the business has no way to reconvert the lead, so no lead is
    captured (Requirement 12.1).

    Attributes:
        name: The caller's name, if given. Informational only.
        phone: A phone number, if given. Considered usable when it carries at
            least :data:`_MIN_PHONE_DIGITS` digits.
        email: An email address, if given. Considered usable when it has the
            structural ``local@domain.tld`` shape.
    """

    name: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None

    @property
    def has_phone(self) -> bool:
        """True iff a usable phone number is present."""
        digits = re.sub(r"\D", "", _clean(self.phone))
        return len(digits) >= _MIN_PHONE_DIGITS

    @property
    def has_email(self) -> bool:
        """True iff a structurally valid email is present."""
        return bool(_EMAIL_PATTERN.match(_clean(self.email)))

    @property
    def is_contactable(self) -> bool:
        """True iff the caller can be reached back (phone or email)."""
        return self.has_phone or self.has_email


@dataclass(frozen=True)
class Inquiry:
    """A handled caller inquiry the extractor evaluates for a lead.

    This is the small structural input the extractor reasons over. Upstream the
    AC-4 reasoner produces an action/answer for a turn; the runtime maps a
    non-booking inquiry's gathered details onto this shape.

    Attributes:
        issue: The conversational issue/intent (e.g. ``"pricing-question"``).
        utterance: The caller's relevant utterance / summary of the inquiry.
        contact: Contact details gathered during the inquiry.
        is_booking: ``True`` iff this inquiry resulted in (or is) a booking.
            Leads are only captured from **non-booking** inquiries, so a booking
            inquiry never produces a lead.
        notes: Optional extra context to carry on the lead.
    """

    issue: str
    utterance: str
    contact: ContactInfo
    is_booking: bool = False
    notes: str = ""


# --------------------------------------------------------------------------- #
# Output: Lead                                                                #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Lead:
    """A captured sales/service lead, ready to fan out over CP-3 ``publishLead``.

    The ``tenant_id`` is always the validated session tenant (Requirement 12.3);
    the extractor sources it from ``session.tenant_id`` and never from a
    client-supplied field.

    Attributes:
        tenant_id: The validated session tenant the lead belongs to.
        call_id: The call the lead was captured on.
        issue: The conversational issue the lead came from.
        contact: How to reach the caller back (guaranteed contactable).
        inquiry: The caller's utterance / inquiry summary.
        notes: Any extra context carried from the inquiry.
    """

    tenant_id: str
    call_id: str
    issue: str
    contact: ContactInfo
    inquiry: str
    notes: str = ""


# --------------------------------------------------------------------------- #
# Injectable CP-3 lead publisher                                              #
# --------------------------------------------------------------------------- #


@runtime_checkable
class LeadPublisher(Protocol):
    """Publishes a captured lead to CP-3 (the ``publishLead`` fan-out mutation).

    Declared locally and kept to exactly the surface this task needs so the
    extractor stays decoupled from the concurrent per-turn publish work (task
    12.2, ``agent/src/agentcore/publish/**``) and from the AC-4 reasoner. A
    production adapter invokes the CP-3 ``publishLead`` mutation, which sets the
    tenant from the validated SE-1 session and performs no persistent write
    (design Req 3.7, 12.3).
    """

    def publish_lead(self, tenant_id: str, lead: Lead) -> None:
        """Invoke CP-3 ``publishLead`` with the tenant set from the SE-1 session."""
        ...


# --------------------------------------------------------------------------- #
# The extractor                                                               #
# --------------------------------------------------------------------------- #


class LeadExtractor:
    """Captures leads from non-booking, contactable inquiries and publishes them.

    Args:
        publisher: The injected CP-3 lead publisher used to fan out captured
            leads.
    """

    def __init__(self, publisher: LeadPublisher) -> None:
        self._publisher = publisher

    def extract(self, session: Session, inquiry: Inquiry) -> Optional[Lead]:
        """Extract and publish a :class:`Lead`, or do nothing.

        Returns a :class:`Lead` (already published) when ``inquiry`` is a
        non-booking inquiry carrying contactable info; otherwise returns ``None``
        and publishes nothing.

        Args:
            session: The AC-1 session holding the validated SE-1 tenant.
            inquiry: The handled inquiry to evaluate.

        Raises:
            LeadScopeError: ``session`` lacks a usable tenant scope.
            LeadError: ``inquiry`` is not a valid :class:`Inquiry`.
        """
        self._validate_session(session)
        if not isinstance(inquiry, Inquiry):
            raise LeadError("extract() requires an Inquiry")

        # Leads come only from non-booking conversations.
        if inquiry.is_booking:
            return None

        # No way to reach the caller back -> capture/publish nothing (Req 12.1).
        if not inquiry.contact.is_contactable:
            return None

        lead = Lead(
            tenant_id=session.tenant_id,
            call_id=session.call_id,
            issue=inquiry.issue,
            contact=inquiry.contact,
            inquiry=inquiry.utterance,
            notes=inquiry.notes,
        )
        # Tenant on the fan-out is the validated session tenant (Req 12.2, 12.3).
        self._publisher.publish_lead(session.tenant_id, lead)
        return lead

    @staticmethod
    def _validate_session(session: Session) -> None:
        if not isinstance(session, Session):
            raise LeadScopeError(
                "extract() requires an AC-1 Session carrying the validated tenant"
            )
        if not isinstance(session.tenant_id, str) or not session.tenant_id.strip():
            raise LeadScopeError("session is missing a tenant scope")


__all__ = [
    "ContactInfo",
    "Inquiry",
    "Lead",
    "LeadExtractor",
    "LeadPublisher",
    "LeadError",
    "LeadScopeError",
]
