"""AC-3 Memory hydration (task 11.1).

The AC-3 Memory component hydrates the two kinds of context the reasoner (AC-4)
needs for a turn, **both scoped to the session's tenant** (design.md
"AC-3 — Memory"; Requirements 8.1–8.4; steering ``bedrock-agentcore.md`` and
``multi-tenant-platform.md``):

  - **short-term** — within-call context from the DM-1 Redis store, keyed
    ``t:<tenantId>:call:<callId>:...`` (the same namespace enforced on the
    TypeScript side in ``data/redis``).
  - **long-term** — semantically-recalled context from the DM-3 embedding store
    (pgvector/OpenSearch), whose similarity search is pinned to the requesting
    ``tenantId``.

The non-negotiable tenant rule
------------------------------
Every hydration read is scoped to ``session.tenant_id`` — which itself only ever
comes from a validated SE-1 session (AC-1, assumption A3). No tenant is ever
taken from a client-supplied field. Cross-tenant context is excluded **by
construction** at three layers (Requirements 8.3, 8.4; Property 4):

  1. *Tenant-prefixed short-term keys.* Short-term reads are confined to the
     ``t:<tenantId>:`` namespace, so a read in tenant ``T``'s context cannot
     address another tenant's keys.
  2. *Tenant-filtered similarity search.* The long-term store is asked to search
     within ``T`` only; the predicate ``tenantId = T`` is part of the query.
  3. *Defense-in-depth filter.* Whatever the stores return, Memory independently
     drops any short-term record whose key escapes ``T``'s namespace and any
     long-term row whose ``tenant_id`` is not exactly ``T``. A buggy or
     compromised store therefore still cannot leak a foreign tenant's context
     through Memory.

Injectable, infra-free stores
-----------------------------
Memory depends on two *narrow* store protocols — :class:`ShortTermMemoryStore`
and :class:`LongTermMemoryStore` — rather than concrete Redis/pgvector drivers,
so it is unit-testable entirely in memory. Production injects thin adapters over
the DM-1 Redis client and the DM-3 embedding store; tests inject the in-memory
fakes used by the suite.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Mapping, Optional, Protocol, Sequence, runtime_checkable

#: Default number of long-term (semantic) matches to request per hydration.
DEFAULT_LONG_TERM_TOP_K = 8

#: Root namespace segment for every short-term key: ``t``. Mirrors
#: ``data/redis/keys`` (``TENANT_NAMESPACE``).
TENANT_NAMESPACE = "t"
#: Separator between key segments.
KEY_SEPARATOR = ":"

#: Allowed shape of a ``tenantId`` / ``callId``: 1–128 chars, must start
#: alphanumeric, only ``_``/``-`` otherwise — notably NO ``:`` so an id can never
#: inject an extra key segment. Mirrors the constraint shared by the DM-1 key
#: builder, the DM-2 query builder, and the AC-1 runtime.
_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")


# --------------------------------------------------------------------------- #
# Errors                                                                      #
# --------------------------------------------------------------------------- #


class MemoryError(Exception):
    """Base class for AC-3 Memory failures."""


class MemoryScopeError(MemoryError):
    """A tenant/call scope is missing or malformed.

    Raised BEFORE any store read is issued, so an unscoped or malformed
    hydration can never reach the backing stores (Requirement 5.3 spirit applied
    to Memory).
    """


# --------------------------------------------------------------------------- #
# Scope validation helpers                                                    #
# --------------------------------------------------------------------------- #


def _is_valid_id(value: object) -> bool:
    """True iff ``value`` is a string safe to use as a tenant/call scope."""
    return isinstance(value, str) and bool(_ID_PATTERN.match(value))


def _assert_valid_tenant_id(tenant_id: object) -> None:
    if not _is_valid_id(tenant_id):
        raise MemoryScopeError(
            f"a valid tenant scope is required for hydration: invalid tenantId "
            f"{tenant_id!r}"
        )


def _assert_valid_call_id(call_id: object) -> None:
    if not _is_valid_id(call_id):
        raise MemoryScopeError(
            f"a valid call scope is required for hydration: invalid callId "
            f"{call_id!r}"
        )


def tenant_prefix(tenant_id: str) -> str:
    """The tenant key prefix ``t:<tenantId>:`` — the boundary a short-term read
    is confined to. Mirrors ``data/redis/keys.tenantPrefix``."""
    _assert_valid_tenant_id(tenant_id)
    return f"{TENANT_NAMESPACE}{KEY_SEPARATOR}{tenant_id}{KEY_SEPARATOR}"


def is_within_tenant(tenant_id: str, key: object) -> bool:
    """True iff ``key`` is a string within tenant ``T``'s namespace ``t:<T>:``.

    Mirrors ``data/redis/keys.isWithinTenant``: a tenant prefix that is merely a
    string-prefix of another tenant (e.g. ``acme`` vs ``acme-evil``) does NOT
    match, because the trailing separator is part of the boundary.
    """
    if not _is_valid_id(tenant_id):
        return False
    prefix = f"{TENANT_NAMESPACE}{KEY_SEPARATOR}{tenant_id}{KEY_SEPARATOR}"
    return isinstance(key, str) and key.startswith(prefix)


# --------------------------------------------------------------------------- #
# Records + result                                                            #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ShortTermRecord:
    """One within-call short-term entry resolved from the DM-1 store.

    Attributes:
        key: The full Redis key ``t:<tenantId>:call:<callId>:...``. The tenant
            prefix on this key is what confines the entry to its owning tenant.
        value: The stored value.
    """

    key: str
    value: str


@dataclass(frozen=True)
class LongTermRecord:
    """One semantically-recalled row from the DM-3 embedding store.

    Attributes:
        tenant_id: The owning tenant tagged on the embedding row. Memory's
            defense-in-depth filter drops any row whose ``tenant_id`` is not the
            session tenant.
        document_id: Identifier of the recalled document/chunk.
        content: The recalled text/content.
        score: Similarity score (higher is more similar).
        metadata: Optional opaque metadata carried by the row.
    """

    tenant_id: str
    document_id: str
    content: str
    score: float
    metadata: Mapping[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class HydratedMemory:
    """The result of :meth:`Memory.hydrate`: ``{ short_term, long_term }``.

    Both collections are guaranteed to contain only the session tenant's
    context. Exposes :attr:`short_term` / :attr:`long_term` attributes and is
    also subscriptable (``result["short_term"]``) to match the design's
    ``{ shortTerm, longTerm }`` shape.
    """

    short_term: tuple[ShortTermRecord, ...]
    long_term: tuple[LongTermRecord, ...]

    def __getitem__(self, key: str) -> tuple[object, ...]:
        if key in ("short_term", "shortTerm"):
            return self.short_term
        if key in ("long_term", "longTerm"):
            return self.long_term
        raise KeyError(key)


# --------------------------------------------------------------------------- #
# Injectable store protocols (infra-free; unit-testable)                      #
# --------------------------------------------------------------------------- #


@runtime_checkable
class ShortTermMemoryStore(Protocol):
    """Tenant/call-scoped read surface over the DM-1 Redis short-term store.

    The production adapter wraps ``data/redis`` ``ShortTermStore.listCall`` (which
    already confines its scan to the ``t:<tenantId>:call:<callId>:`` prefix);
    tests inject an in-memory fake. Implementations MUST return only entries for
    the requested tenant/call — Memory re-checks every key regardless.
    """

    def list_call(self, tenant_id: str, call_id: str) -> Sequence[ShortTermRecord]:
        """Return the short-term entries for ``tenant_id``/``call_id``."""
        ...


@runtime_checkable
class LongTermMemoryStore(Protocol):
    """Tenant-scoped semantic-recall surface over the DM-3 embedding store.

    The production adapter wraps the pgvector/OpenSearch similarity search with
    its ``tenantId = :t`` predicate (design.md "DM-3"); tests inject an in-memory
    fake. Implementations MUST restrict results to ``tenant_id`` — Memory
    re-filters every row regardless.
    """

    def similarity_search(
        self, tenant_id: str, query: object, *, top_k: int
    ) -> Sequence[LongTermRecord]:
        """Return up to ``top_k`` rows for ``tenant_id`` most similar to ``query``."""
        ...


# --------------------------------------------------------------------------- #
# The Memory component                                                        #
# --------------------------------------------------------------------------- #


@runtime_checkable
class SessionContext(Protocol):
    """The minimal session surface Memory needs.

    Satisfied by :class:`agentcore.session.runtime.Session`. Depending on a
    structural protocol (rather than importing the concrete session) keeps Memory
    decoupled and unit-testable while still requiring the only field that may
    originate a tenant: ``tenant_id`` (validated SE-1 tenant).
    """

    @property
    def tenant_id(self) -> str: ...

    @property
    def call_id(self) -> str: ...


class Memory:
    """AC-3 Memory: hydrate tenant-scoped short- and long-term context.

    Args:
        short_term_store: Injectable DM-1 short-term read surface.
        long_term_store: Injectable DM-3 embedding-recall surface.
        long_term_top_k: Default number of semantic matches to request.

    The component owns no infrastructure; everything is injected so it can be
    exercised entirely in memory.
    """

    def __init__(
        self,
        short_term_store: ShortTermMemoryStore,
        long_term_store: LongTermMemoryStore,
        *,
        long_term_top_k: int = DEFAULT_LONG_TERM_TOP_K,
    ) -> None:
        if not isinstance(long_term_top_k, int) or long_term_top_k <= 0:
            raise MemoryScopeError(
                f"long_term_top_k must be a positive integer, got "
                f"{long_term_top_k!r}"
            )
        self._short_term = short_term_store
        self._long_term = long_term_store
        self._top_k = long_term_top_k

    def hydrate(
        self,
        session: SessionContext,
        *,
        query: object = None,
        top_k: Optional[int] = None,
    ) -> HydratedMemory:
        """Hydrate ``{ short_term, long_term }`` for ``session``'s tenant.

        Short-term context is read from the DM-1 store for the session's
        tenant/call; long-term context is recalled from the DM-3 store within the
        session tenant only. Both results are filtered (defense in depth) so no
        other tenant's context can appear (Requirements 8.1–8.4).

        Args:
            session: The active AC-1 session; its ``tenant_id`` (validated SE-1
                tenant) is the sole scope for every read.
            query: Optional semantic-recall input (e.g. the current turn /
                embedding) passed to the long-term similarity search. When
                ``None``, long-term hydration is skipped (no query → no recall).
            top_k: Optional override for the number of long-term matches.

        Returns:
            A :class:`HydratedMemory` containing only the session tenant's
            context.

        Raises:
            MemoryScopeError: if the session's tenant/call scope is missing or
                malformed — raised before any store read.
        """
        tenant_id = getattr(session, "tenant_id", None)
        call_id = getattr(session, "call_id", None)
        # Fail closed on a missing/malformed scope before touching any store.
        _assert_valid_tenant_id(tenant_id)
        _assert_valid_call_id(call_id)

        effective_top_k = self._top_k if top_k is None else top_k
        if not isinstance(effective_top_k, int) or effective_top_k <= 0:
            raise MemoryScopeError(
                f"top_k must be a positive integer, got {effective_top_k!r}"
            )

        short_term = self._hydrate_short_term(tenant_id, call_id)
        long_term = self._hydrate_long_term(tenant_id, query, effective_top_k)
        return HydratedMemory(short_term=short_term, long_term=long_term)

    # -- short-term --------------------------------------------------------- #

    def _hydrate_short_term(
        self, tenant_id: str, call_id: str
    ) -> tuple[ShortTermRecord, ...]:
        """Read short-term context confined to the tenant's key namespace.

        Layer 1 (by construction): the store is asked only for this tenant/call.
        Layer 3 (defense in depth): every returned record whose key escapes the
        ``t:<tenantId>:`` namespace is dropped rather than surfaced.
        """
        records = self._short_term.list_call(tenant_id, call_id)
        return tuple(
            record
            for record in records
            if is_within_tenant(tenant_id, record.key)
        )

    # -- long-term ---------------------------------------------------------- #

    def _hydrate_long_term(
        self, tenant_id: str, query: object, top_k: int
    ) -> tuple[LongTermRecord, ...]:
        """Recall long-term context restricted to the tenant.

        Layer 2 (by construction): the similarity search is pinned to
        ``tenant_id``. Layer 3 (defense in depth): any row whose ``tenant_id`` is
        not exactly the session tenant is dropped.
        """
        if query is None:
            # No semantic-recall input → no long-term hydration this turn.
            return ()
        rows = self._long_term.similarity_search(tenant_id, query, top_k=top_k)
        return tuple(row for row in rows if row.tenant_id == tenant_id)


__all__ = [
    "DEFAULT_LONG_TERM_TOP_K",
    "TENANT_NAMESPACE",
    "Memory",
    "MemoryError",
    "MemoryScopeError",
    "HydratedMemory",
    "ShortTermRecord",
    "LongTermRecord",
    "ShortTermMemoryStore",
    "LongTermMemoryStore",
    "SessionContext",
    "tenant_prefix",
    "is_within_tenant",
]
