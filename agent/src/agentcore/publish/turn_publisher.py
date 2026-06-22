"""Per-turn live-state publication coordinator (task 12.2).

On every turn the AC-1 runtime must reflect the call on the dashboard in near
real time (design.md "Per-turn live-state flow (AgentCore → CP-3)";
Requirements 10.1, 10.2, 10.3; steering ``bedrock-agentcore.md``):

  * **Req 10.1** — when the runtime finishes processing a caller turn, invoke the
    CP-3 ``publishCallUpdate`` Publish_Mutation with the updated Call state.
  * **Req 10.2** — when a caller or agent utterance is *finalized* for a turn,
    invoke the CP-3 ``appendTranscript`` Publish_Mutation with the transcript
    segment.
  * **Req 10.3** — every Publish_Mutation sets the tenant from the **validated
    SE-1 session**, never from a client-supplied field.

What this module owns
---------------------
:class:`TurnPublisher` is a thin, infra-free coordinator the runtime calls per
turn. It takes the CP-3 publisher by injection (the :class:`TurnStatePublisher`
protocol), so it is fully unit-testable without AppSync. Its single
responsibility is to **stamp the validated session tenant onto every payload**
before fanning out — the non-negotiable isolation rule (steering
``multi-tenant-platform.md``: "IAM ``publish*`` mutations set tenant from the
validated SE-1 session").

Scope / boundaries
------------------
* The on-the-wire argument shapes of ``publishCallUpdate`` / ``appendTranscript``
  are owned by the imported CP-3 SDL (``@alchemist/contracts``
  ``graphql/schema.graphql``) and mapped by the publish resolver (task 7.3).
  :class:`CallState` / :class:`TranscriptSegment` are the small structural
  payloads the Python runtime hands to the injected publisher — they are *not*
  a re-authoring of the contract types.
* Escalation publication (``publishCallEscalated``, task 12.1) lives in the
  reasoner and is intentionally not duplicated here. Lead extraction
  (``publishLead``, task 12.3) is a separate task. A concrete CP-3 publisher may
  implement this module's :class:`TurnStatePublisher` *and* the reasoner's
  ``CallStatePublisher`` to fan out all of them.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Any, Mapping, Optional, Protocol, Sequence, runtime_checkable

from agentcore.session.runtime import Session

__all__ = [
    "Speaker",
    "CallState",
    "TranscriptSegment",
    "TurnStatePublisher",
    "TurnPublisher",
    "PublishScopeError",
]


# --------------------------------------------------------------------------- #
# Errors                                                                      #
# --------------------------------------------------------------------------- #


class PublishScopeError(Exception):
    """A publish was attempted without a valid validated-session tenant scope.

    Raised BEFORE the injected publisher is invoked so a payload can never be
    fanned out without a trusted tenant (Requirement 10.3).
    """


# --------------------------------------------------------------------------- #
# Payloads (small structural shapes; contract types owned by the CP-3 SDL)    #
# --------------------------------------------------------------------------- #


class Speaker(str, Enum):
    """Who produced a transcript utterance."""

    CALLER = "caller"
    AGENT = "agent"


@dataclass(frozen=True)
class CallState:
    """Updated Call state published on turn completion (``publishCallUpdate``).

    The tenant on the published payload MUST be the validated session tenant
    (Requirement 10.3); :class:`TurnPublisher` always overwrites :attr:`tenant_id`
    from ``session.tenant_id`` so any value set here is advisory only.

    Attributes:
        call_id: The call this state belongs to.
        tenant_id: The owning tenant. Overwritten by the coordinator from the
            validated session before fan-out.
        status: Optional coarse call status (e.g. ``"in_progress"``).
        sentiment: Optional sentiment score carried on ``Call.sentiment``
            (Requirement 10.4); ``None`` when not yet scored.
        turn: Optional 1-based index of the completed turn.
        data: Additional opaque fields mapped onto the SDL Call type by the
            publish resolver; opaque to this coordinator.
    """

    call_id: str
    tenant_id: str
    status: Optional[str] = None
    sentiment: Optional[float] = None
    turn: Optional[int] = None
    data: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class TranscriptSegment:
    """A transcript segment published when an utterance is finalized.

    Only *finalized* utterances are appended (Requirement 10.2); interim
    (``final=False``) segments are skipped by the coordinator. The tenant is
    overwritten from the validated session before fan-out (Requirement 10.3).

    Attributes:
        call_id: The call this segment belongs to.
        tenant_id: The owning tenant. Overwritten by the coordinator from the
            validated session before fan-out.
        speaker: Who produced the utterance (caller or agent).
        text: The finalized utterance text.
        turn: Optional 1-based index of the turn this segment belongs to.
        final: Whether the utterance is finalized. Non-final segments are not
            published.
    """

    call_id: str
    tenant_id: str
    speaker: Speaker
    text: str
    turn: Optional[int] = None
    final: bool = True


# --------------------------------------------------------------------------- #
# Injectable CP-3 turn-state publisher                                        #
# --------------------------------------------------------------------------- #


@runtime_checkable
class TurnStatePublisher(Protocol):
    """The CP-3 per-turn fan-out surface the coordinator drives.

    Mirrors the reasoner's ``CallStatePublisher`` (which owns
    ``publish_call_escalated``); this protocol adds the two per-turn mutations so
    a concrete CP-3 publisher can implement both. Injecting it keeps
    :class:`TurnPublisher` testable without AppSync.
    """

    def publish_call_update(self, tenant_id: str, call: CallState) -> None:
        """Invoke CP-3 ``publishCallUpdate`` with the tenant set from SE-1."""
        ...

    def append_transcript(self, tenant_id: str, segment: TranscriptSegment) -> None:
        """Invoke CP-3 ``appendTranscript`` with the tenant set from SE-1."""
        ...


# --------------------------------------------------------------------------- #
# The coordinator                                                             #
# --------------------------------------------------------------------------- #


class TurnPublisher:
    """Per-turn live-state coordinator the AC-1 runtime calls each turn.

    The runtime hands it the active :class:`Session` plus the turn's Call state
    and any finalized utterances; the coordinator stamps the validated session
    tenant onto every payload and fans them out through the injected publisher.

    Args:
        publisher: The injected CP-3 turn-state publisher.
    """

    def __init__(self, publisher: TurnStatePublisher) -> None:
        self._publisher = publisher

    def publish_call_update(self, session: Session, call: CallState) -> CallState:
        """Fan out ``publishCallUpdate`` for a completed turn (Req 10.1).

        The Call payload's tenant is set from the validated session
        (Requirement 10.3), overriding whatever :attr:`CallState.tenant_id`
        carried, then handed to the publisher. Returns the tenant-stamped payload
        that was published (useful for callers/tests).

        Raises:
            PublishScopeError: the session lacks a valid tenant scope.
            TypeError: ``call`` is not a :class:`CallState`.
        """
        tenant_id = self._tenant_of(session)
        if not isinstance(call, CallState):
            raise TypeError("publish_call_update requires a CallState")
        scoped = replace(call, tenant_id=tenant_id)
        self._publisher.publish_call_update(tenant_id, scoped)
        return scoped

    def append_transcript(
        self, session: Session, segment: TranscriptSegment
    ) -> Optional[TranscriptSegment]:
        """Fan out ``appendTranscript`` for a finalized utterance (Req 10.2).

        Only finalized utterances are published; a non-final (interim) segment is
        skipped and ``None`` is returned. For a finalized segment the tenant is
        set from the validated session (Requirement 10.3) before fan-out, and the
        tenant-stamped payload is returned.

        Raises:
            PublishScopeError: the session lacks a valid tenant scope.
            TypeError: ``segment`` is not a :class:`TranscriptSegment`.
        """
        tenant_id = self._tenant_of(session)
        if not isinstance(segment, TranscriptSegment):
            raise TypeError("append_transcript requires a TranscriptSegment")
        if not segment.final:
            # Only finalized utterances are appended (Requirement 10.2).
            return None
        scoped = replace(segment, tenant_id=tenant_id)
        self._publisher.append_transcript(tenant_id, scoped)
        return scoped

    def publish_turn(
        self,
        session: Session,
        call: CallState,
        segments: Sequence[TranscriptSegment] = (),
    ) -> None:
        """Publish everything a completed turn produces, in order.

        Convenience for the runtime: invokes ``publishCallUpdate`` for the turn's
        Call state, then ``appendTranscript`` for each *finalized* utterance in
        ``segments`` (interim segments are skipped). Every payload is tenant-set
        from the validated session (Requirement 10.3).

        Raises:
            PublishScopeError: the session lacks a valid tenant scope (raised
                before anything is published).
            TypeError: ``call``/a segment has the wrong type.
        """
        # Validate the scope up front so a bad session publishes nothing.
        self._tenant_of(session)
        if not all(isinstance(s, TranscriptSegment) for s in segments):
            raise TypeError("segments must all be TranscriptSegment instances")

        self.publish_call_update(session, call)
        for segment in segments:
            self.append_transcript(session, segment)

    # -- internals ---------------------------------------------------------- #

    @staticmethod
    def _tenant_of(session: Session) -> str:
        """Return the validated session tenant, or raise if it is missing/bad.

        ``tenantId`` may only come from the validated SE-1 session
        (Requirement 10.3; steering ``multi-tenant-platform.md``), so a non-
        :class:`Session` or a session without a usable tenant is refused before
        any fan-out.
        """
        if not isinstance(session, Session):
            raise PublishScopeError(
                "a publish requires an AC-1 Session carrying the validated SE-1 "
                "tenant; tenantId must never come from a client-supplied field"
            )
        tenant_id = session.tenant_id
        if not isinstance(tenant_id, str) or not tenant_id.strip():
            raise PublishScopeError("session is missing a tenant scope")
        return tenant_id
