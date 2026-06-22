"""AC-4 Bedrock reasoner with Guardrails and a confidence gate (task 12.1).

The reasoner turns a caller turn into either a concrete :class:`Action` or an
:class:`Escalation` (design.md "AC-4 — Bedrock Reasoner + Guardrails";
Requirements 9.1–9.4, 11.1, 11.2; steering ``bedrock-agentcore.md``).

What this module owns
---------------------
:meth:`BedrockReasoner.reason` ``(session, turn, context)``:

  1. **Tenant scoping (Req 9.4).** Reasoning inputs are scoped to
     ``session.tenant_id``. A :class:`ReasoningContext` carrying a *different*
     tenant is refused before any model call — hydrated context can never leak
     across tenants.
  2. **Escalation finality (Req 11.2 / Property 13).** If the turn's issue has
     already been escalated on this call (``session.is_issue_escalated``), the
     reasoner does **not** re-engage it: it returns an :class:`Escalation`
     without calling the model and without producing an action.
  3. **Generate with Guardrails (Req 9.1).** Otherwise it asks the injected
     Bedrock client to generate a candidate with Guardrails applied.
  4. **Confidence gate (Req 9.2 / Property 12).** If the candidate's confidence
     is below the configured threshold (or is missing/malformed — fail closed),
     the reasoner escalates rather than guessing.
  5. **Guardrails gate (Req 9.3 / Property 12).** If Guardrails blocked the
     candidate, the reasoner withholds it and escalates.
  6. **On escalation (Req 11.1).** It marks the issue on the session
     (``session.mark_issue_escalated``) so it is never re-engaged, and triggers
     the injected publisher's ``publish_call_escalated(tenant_id, call)``.
  7. Otherwise it returns a confident, non-blocked :class:`Action`.

Everything is injectable + infra-free
--------------------------------------
The Bedrock LLM + Guardrails are modeled behind the :class:`BedrockReasoningClient`
protocol, and the CP-3 escalation publish is modeled behind the
:class:`CallStatePublisher` protocol. Both are injected, so this module is fully
unit-testable without Bedrock or AppSync.

Scope note
----------
Per-turn live publication (``publishCallUpdate`` / ``appendTranscript``, task
12.2) and lead extraction (``publishLead``, task 12.3) are **not** implemented
here. The reasoner is designed so they plug in: 12.2 can wrap ``reason`` and the
same injected :class:`CallStatePublisher` can grow those publish methods, and a
returned :class:`Action` carries the structured output a lead extractor reads.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Mapping, Optional, Protocol, Sequence, Union, runtime_checkable

from agentcore.session.runtime import Session

#: Default confidence threshold. A candidate action is only acted on when its
#: confidence is >= this value; below it the reasoner escalates (Req 9.2).
DEFAULT_CONFIDENCE_THRESHOLD = 0.7


# --------------------------------------------------------------------------- #
# Errors                                                                      #
# --------------------------------------------------------------------------- #


class ReasonerError(Exception):
    """Base class for AC-4 reasoner failures."""


class ReasoningScopeError(ReasonerError):
    """Inputs are missing a tenant scope or cross a tenant boundary.

    Raised BEFORE any model call so a malformed or cross-tenant request can
    never reach the Bedrock client (Requirement 9.4).
    """


class InvalidTurnError(ReasonerError):
    """The turn is missing the fields the reasoner needs (e.g. an issue)."""


# --------------------------------------------------------------------------- #
# Inputs: turn + hydrated context                                             #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Turn:
    """One caller turn handed to the reasoner.

    Attributes:
        issue: A stable identifier for the conversational issue/intent this turn
            is about (e.g. ``"book-appointment"``, ``"refund-dispute"``). This is
            the unit of escalation finality: once an issue is escalated it is
            never re-engaged (Property 13), so callers must key recurring intents
            to the same ``issue`` value.
        utterance: The caller's finalized utterance text for this turn.
    """

    issue: str
    utterance: str


@dataclass(frozen=True)
class ReasoningContext:
    """Tenant-scoped context hydrated for the turn (AC-3 Memory output shape).

    AC-3 Memory (task 11.1) hydrates short/long-term context; this is the shape
    the reasoner consumes. The ``tenant_id`` is carried so the reasoner can prove
    the context belongs to the session's tenant before reasoning over it
    (Requirement 9.4). An *empty* context (no hydrated memory) is valid.

    Attributes:
        tenant_id: The tenant the context was hydrated for. When set it MUST
            equal the session tenant; ``None`` means "no tenant assertion"
            (e.g. an explicitly empty context) and is accepted.
        short_term: Short-term (Redis/DM-1) context items, opaque to the reasoner.
        long_term: Long-term (embeddings/DM-3) context items, opaque to the reasoner.
    """

    tenant_id: Optional[str] = None
    short_term: Sequence[Any] = field(default_factory=tuple)
    long_term: Sequence[Any] = field(default_factory=tuple)


# --------------------------------------------------------------------------- #
# Injectable Bedrock client (LLM + Guardrails)                                #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ReasoningRequest:
    """The tenant-scoped request handed to the Bedrock client.

    Built by the reasoner from the session/turn/context so the ``tenant_id`` on
    the request is always the validated session tenant (Requirement 9.4) — the
    client never sees a client-supplied tenant.
    """

    tenant_id: str
    issue: str
    utterance: str
    context: ReasoningContext


@dataclass(frozen=True)
class ReasoningCandidate:
    """A candidate produced by the Bedrock client with Guardrails applied.

    The client applies Guardrails internally and reports the verdict here; the
    reasoner reads :attr:`guardrail_blocked` and :attr:`confidence` to decide
    whether to act or escalate. It never inspects model internals.

    Attributes:
        reply: The candidate agent reply text.
        confidence: Model confidence for the proposed action in ``[0.0, 1.0]``.
            A value that is ``None``, non-finite, or out of range is treated as
            failing the gate (fail-closed escalation).
        guardrail_blocked: ``True`` iff Guardrails blocked this candidate. A
            blocked candidate is withheld and escalated (Requirement 9.3).
        guardrail_reason: Optional human-readable reason a candidate was blocked.
        action_type: The kind of action proposed (e.g. ``"book"``, ``"order"``),
            or ``None`` if the candidate is a plain reply with no tool action.
        action_payload: Structured arguments for the action, opaque here.
    """

    reply: str
    confidence: Optional[float]
    guardrail_blocked: bool = False
    guardrail_reason: Optional[str] = None
    action_type: Optional[str] = None
    action_payload: Optional[Mapping[str, Any]] = None


@runtime_checkable
class BedrockReasoningClient(Protocol):
    """Generates a candidate with the Bedrock LLM and Guardrails applied.

    Injecting this keeps the reasoner independent of the Bedrock runtime so it is
    unit-testable without live model access. A production implementation invokes
    the model with the configured Guardrail and maps the result onto a
    :class:`ReasoningCandidate`.
    """

    def generate(self, request: ReasoningRequest) -> ReasoningCandidate:
        """Return a Guardrailed candidate for ``request``."""
        ...


# --------------------------------------------------------------------------- #
# Injectable CP-3 escalation publisher                                        #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Call:
    """Minimal Call state published on escalation.

    The on-the-wire shape of ``publishCallEscalated``'s argument is owned by the
    imported CP-3 SDL and is mapped by the publish resolver (task 7.3) / the
    SE-1-tenant publish wiring; this is the small structural payload the Python
    reasoner hands to the injected publisher. The tenant on the published payload
    must be the validated session tenant (Requirement 11.3) — the reasoner always
    sources it from ``session.tenant_id``.

    Attributes:
        call_id: The escalated call.
        tenant_id: The validated session tenant.
        escalated_issue: The issue that triggered the escalation.
        reason: Why the call was escalated.
    """

    call_id: str
    tenant_id: str
    escalated_issue: str
    reason: "EscalationReason"


@runtime_checkable
class CallStatePublisher(Protocol):
    """Publishes live call state to CP-3 (the fan-out ``publish*`` mutations).

    For task 12.1 only :meth:`publish_call_escalated` is required. The same
    injected publisher is the natural home for ``publish_call_update`` /
    ``append_transcript`` (task 12.2) and ``publish_lead`` (task 12.3); they are
    intentionally not declared here so this task stays scoped.
    """

    def publish_call_escalated(self, tenant_id: str, call: Call) -> None:
        """Invoke CP-3 ``publishCallEscalated`` with the tenant set from SE-1."""
        ...


# --------------------------------------------------------------------------- #
# Outputs: Action | Escalation                                                #
# --------------------------------------------------------------------------- #


class EscalationReason(str, Enum):
    """Why the reasoner escalated instead of acting."""

    #: Candidate confidence was below the configured threshold (or malformed).
    LOW_CONFIDENCE = "low_confidence"
    #: Guardrails blocked the candidate response.
    GUARDRAILS_BLOCKED = "guardrails_blocked"
    #: The issue was already escalated on this call — never re-engaged.
    ALREADY_ESCALATED = "already_escalated"


@dataclass(frozen=True)
class Action:
    """A confident, Guardrails-cleared action the agent will take.

    Returned only when the candidate cleared Guardrails AND met the confidence
    threshold. Carries the structured output downstream consumers (Tool Gateway
    task 10.x, lead extraction task 12.3) read.
    """

    issue: str
    reply: str
    confidence: float
    action_type: Optional[str] = None
    action_payload: Optional[Mapping[str, Any]] = None


@dataclass(frozen=True)
class Escalation:
    """A one-way handoff to a human; no action/guessed response is produced."""

    issue: str
    reason: EscalationReason
    detail: str = ""
    #: ``True`` iff this call triggered a fresh ``publishCallEscalated``. ``False``
    #: when the issue was already escalated (no duplicate publish, Property 13).
    published: bool = False


#: The reasoner's typed result.
ReasonResult = Union[Action, Escalation]


# --------------------------------------------------------------------------- #
# The reasoner                                                                #
# --------------------------------------------------------------------------- #


class BedrockReasoner:
    """AC-4 reasoner: generate with Guardrails, gate on confidence, escalate.

    Args:
        client: The injected Bedrock LLM + Guardrails client.
        publisher: The injected CP-3 publisher used to fan out escalations.
        confidence_threshold: Minimum confidence to act on a candidate. A
            candidate with confidence strictly below this escalates
            (Requirement 9.2). Must be within ``[0.0, 1.0]``.
    """

    def __init__(
        self,
        client: BedrockReasoningClient,
        publisher: CallStatePublisher,
        *,
        confidence_threshold: float = DEFAULT_CONFIDENCE_THRESHOLD,
    ) -> None:
        if not _is_finite_number(confidence_threshold) or not (
            0.0 <= float(confidence_threshold) <= 1.0
        ):
            raise ReasonerError(
                f"confidence_threshold must be a number in [0.0, 1.0], got "
                f"{confidence_threshold!r}"
            )
        self._client = client
        self._publisher = publisher
        self._threshold = float(confidence_threshold)

    @property
    def confidence_threshold(self) -> float:
        """The configured minimum confidence required to act."""
        return self._threshold

    def reason(
        self,
        session: Session,
        turn: Turn,
        context: Optional[ReasoningContext] = None,
    ) -> ReasonResult:
        """Reason over a turn and return an :class:`Action` or :class:`Escalation`.

        See the module docstring for the full decision flow. Inputs are scoped to
        ``session.tenant_id``; an already-escalated issue is never re-engaged; a
        below-threshold or Guardrails-blocked candidate escalates.

        Raises:
            ReasoningScopeError: ``session`` lacks a tenant, or ``context``
                asserts a different tenant.
            InvalidTurnError: ``turn`` is missing a usable issue/utterance.
        """
        self._validate_session(session)
        self._validate_turn(turn)
        context = context if context is not None else ReasoningContext()
        self._validate_context_scope(session, context)

        # (Property 13) Never re-engage an issue already escalated on this call.
        if session.is_issue_escalated(turn.issue):
            return Escalation(
                issue=turn.issue,
                reason=EscalationReason.ALREADY_ESCALATED,
                detail=(
                    f"issue {turn.issue!r} was already escalated on call "
                    f"{session.call_id!r}; not re-engaging"
                ),
                published=False,
            )

        request = ReasoningRequest(
            tenant_id=session.tenant_id,
            issue=turn.issue,
            utterance=turn.utterance,
            context=context,
        )
        candidate = self._client.generate(request)

        # (Req 9.3 / Property 12) Guardrails block -> withhold + escalate.
        if candidate.guardrail_blocked:
            return self._escalate(
                session,
                turn,
                EscalationReason.GUARDRAILS_BLOCKED,
                candidate.guardrail_reason or "candidate blocked by Guardrails",
            )

        # (Req 9.2 / Property 12) Below-threshold (or malformed) -> escalate.
        if not self._meets_threshold(candidate.confidence):
            return self._escalate(
                session,
                turn,
                EscalationReason.LOW_CONFIDENCE,
                f"confidence {candidate.confidence!r} below threshold "
                f"{self._threshold}",
            )

        # Confident and cleared Guardrails -> act.
        return Action(
            issue=turn.issue,
            reply=candidate.reply,
            confidence=float(candidate.confidence),  # type: ignore[arg-type]
            action_type=candidate.action_type,
            action_payload=candidate.action_payload,
        )

    # -- internals ---------------------------------------------------------- #

    def _escalate(
        self,
        session: Session,
        turn: Turn,
        reason: EscalationReason,
        detail: str,
    ) -> Escalation:
        """Mark the issue escalated and fan out ``publishCallEscalated``.

        Marks BEFORE publishing so the issue is recorded as escalated even if the
        publish fails — guaranteeing it is never re-engaged (Property 13).
        """
        session.mark_issue_escalated(turn.issue)
        call = Call(
            call_id=session.call_id,
            tenant_id=session.tenant_id,
            escalated_issue=turn.issue,
            reason=reason,
        )
        self._publisher.publish_call_escalated(session.tenant_id, call)
        return Escalation(
            issue=turn.issue, reason=reason, detail=detail, published=True
        )

    def _meets_threshold(self, confidence: Optional[float]) -> bool:
        """True iff ``confidence`` is a valid score >= the threshold (fail-closed)."""
        if not _is_finite_number(confidence):
            return False
        value = float(confidence)  # type: ignore[arg-type]
        if not (0.0 <= value <= 1.0):
            return False
        return value >= self._threshold

    @staticmethod
    def _validate_session(session: Session) -> None:
        if not isinstance(session, Session):
            raise ReasoningScopeError(
                "reason() requires an AC-1 Session carrying the validated tenant"
            )
        if not isinstance(session.tenant_id, str) or not session.tenant_id.strip():
            raise ReasoningScopeError("session is missing a tenant scope")

    @staticmethod
    def _validate_turn(turn: Turn) -> None:
        if not isinstance(turn, Turn):
            raise InvalidTurnError("reason() requires a Turn")
        if not isinstance(turn.issue, str) or not turn.issue.strip():
            raise InvalidTurnError("turn.issue must be a non-empty string")
        if not isinstance(turn.utterance, str):
            raise InvalidTurnError("turn.utterance must be a string")

    @staticmethod
    def _validate_context_scope(session: Session, context: ReasoningContext) -> None:
        if not isinstance(context, ReasoningContext):
            raise ReasoningScopeError("context must be a ReasoningContext")
        if (
            context.tenant_id is not None
            and context.tenant_id != session.tenant_id
        ):
            # Cross-tenant context can never feed the reasoner (Requirement 9.4).
            raise ReasoningScopeError(
                f"context tenant {context.tenant_id!r} does not match session "
                f"tenant {session.tenant_id!r}"
            )


def _is_finite_number(value: object) -> bool:
    """True iff ``value`` is a real, finite number (rejects bool/NaN/inf/None)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return math.isfinite(float(value))


__all__ = [
    "DEFAULT_CONFIDENCE_THRESHOLD",
    "BedrockReasoner",
    "Turn",
    "ReasoningContext",
    "ReasoningRequest",
    "ReasoningCandidate",
    "BedrockReasoningClient",
    "Call",
    "CallStatePublisher",
    "EscalationReason",
    "Action",
    "Escalation",
    "ReasonResult",
    "ReasonerError",
    "ReasoningScopeError",
    "InvalidTurnError",
]
