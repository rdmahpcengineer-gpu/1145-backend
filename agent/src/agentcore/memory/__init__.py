"""AC-3 Memory layer for the 1145 AI AgentCore backend.

This package owns memory hydration for a turn (task 11.1):
:mod:`agentcore.memory.memory` hydrates short-term context from the DM-1 Redis
store and long-term context from the DM-3 embedding store, **both scoped to the
session's validated tenant**, excluding any other tenant's context by
construction (tenant-prefixed keys, tenant-filtered similarity search, and a
defense-in-depth filter).
"""

from agentcore.memory.memory import (
    DEFAULT_LONG_TERM_TOP_K,
    TENANT_NAMESPACE,
    HydratedMemory,
    LongTermMemoryStore,
    LongTermRecord,
    Memory,
    MemoryError,
    MemoryScopeError,
    SessionContext,
    ShortTermMemoryStore,
    ShortTermRecord,
    is_within_tenant,
    tenant_prefix,
)

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
