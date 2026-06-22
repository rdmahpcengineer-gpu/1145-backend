"""AC-2 Tool Gateway (task 10.1).

The Tool Gateway turns a *reasoner-selected* tool action into a concrete backend
workflow invocation. It is the AC-2 component in the design (design.md
"AC-2 — Tool Gateway"; Requirements 7.1, 7.3, 7.4, 7.5; steering
``bedrock-agentcore.md``).

Two responsibilities, in order
------------------------------
1. **Validate** the invocation against the imported **AC-2 tool schema**. A
   non-conforming invocation is rejected with a typed
   :class:`ToolValidationError` and **nothing is routed** (Property 11,
   Requirement 7.5). Validation is structural — the tool name must be in the
   allowed set and every required argument must be present and correctly typed.
2. **Route** a valid action to **WF-1** through the injected
   :class:`WorkflowInvoker`, passing the ``tenantId`` taken **only** from the
   session context (Requirements 7.3, 7.4). The gateway never reads a tenant
   from the invocation/client payload (steering ``multi-tenant-platform.md``).

Contracts are imported, never authored
---------------------------------------
The AC-2 tool schema is owned by the ``alchemist_contracts`` package and loaded
via :func:`agentcore.contracts.load_tool_schema` — this module does NOT
re-declare it. Because the real contract may be absent in a dev/test checkout,
the gateway takes an **injectable** :class:`ToolSchema`. Build it from the
imported contract with :meth:`ToolSchema.from_contract` (the production path) or
from a small in-memory document with :func:`build_test_tool_schema` (the
documented test stand-in). Either way the *shape* the gateway expects from the
contract document is a structural projection, described on
:meth:`ToolSchema.from_document`.

Infra-free + testable
---------------------
WF-1 itself is started on the TypeScript side via Step Functions/EventBridge.
Here the gateway depends only on the small :class:`WorkflowInvoker` protocol
(``invoke(tenant_id, action) -> result``) so it is unit/property-testable with no
infrastructure; a real adapter over the WF-1 EventBridge bus / ``StartExecution``
is wired in a later task.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import (
    Any,
    Mapping,
    Optional,
    Protocol,
    TypeVar,
    runtime_checkable,
)

from agentcore.contracts import LoadedToolSchema, load_tool_schema

R = TypeVar("R")


# --------------------------------------------------------------------------- #
# Errors                                                                      #
# --------------------------------------------------------------------------- #


class ToolGatewayError(Exception):
    """Base class for AC-2 Tool Gateway failures."""


class MalformedToolSchemaError(ToolGatewayError):
    """The AC-2 tool schema *document* could not be interpreted structurally.

    This is a configuration/contract problem (the schema we were handed is not
    usable), distinct from :class:`ToolValidationError`, which is about an
    individual *invocation* failing to conform to a valid schema.
    """


class ToolValidationError(ToolGatewayError):
    """An invocation does not conform to the AC-2 tool schema (Requirement 7.5).

    Raised BEFORE anything is routed to WF-1, so a rejected invocation can never
    reach the orchestrator (Property 11). Subclasses identify the failing check.
    """


class UnknownToolError(ToolValidationError):
    """The invocation names a tool that is not in the schema's allowed set."""


class MissingArgumentError(ToolValidationError):
    """A required argument for the tool is absent from the invocation."""


class ArgumentTypeError(ToolValidationError):
    """An argument is present but its value does not match the declared type."""


class UnexpectedArgumentError(ToolValidationError):
    """The invocation carries an argument the tool's schema does not declare."""


# --------------------------------------------------------------------------- #
# Structural tool-schema model (a projection of the imported AC-2 contract)   #
# --------------------------------------------------------------------------- #

#: Mapping of the JSON type names accepted in the tool schema to a predicate
#: that checks a Python value decoded from JSON. ``bool`` is excluded from the
#: numeric types because ``bool`` is a subclass of ``int`` in Python and a
#: boolean is never a valid number/integer argument.
_JSON_TYPE_CHECKERS: dict[str, Any] = {
    "string": lambda v: isinstance(v, str),
    "boolean": lambda v: isinstance(v, bool),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
}


@dataclass(frozen=True)
class ArgumentSpec:
    """One declared argument of a tool.

    Attributes:
        name: The argument name.
        type_name: A JSON type name (one of :data:`_JSON_TYPE_CHECKERS`).
        required: Whether the argument must be present on every invocation.
    """

    name: str
    type_name: str
    required: bool = False

    def matches_type(self, value: Any) -> bool:
        """Return ``True`` iff ``value`` matches this argument's declared type."""
        return _JSON_TYPE_CHECKERS[self.type_name](value)


@dataclass(frozen=True)
class ToolSpec:
    """One tool the gateway may route: its name and declared arguments."""

    name: str
    arguments: Mapping[str, ArgumentSpec]

    @property
    def required_arguments(self) -> tuple[str, ...]:
        return tuple(
            name for name, spec in self.arguments.items() if spec.required
        )


class ToolSchema:
    """The structural projection of the imported AC-2 tool schema.

    The gateway validates invocations against this. It does not re-author the
    contract — :meth:`from_contract` reads the imported document and
    :meth:`from_document` projects it into the small structure validation needs.
    """

    def __init__(self, tools: Mapping[str, ToolSpec]) -> None:
        self._tools: dict[str, ToolSpec] = dict(tools)

    @property
    def tool_names(self) -> frozenset[str]:
        """The allowed tool names."""
        return frozenset(self._tools)

    def tool(self, name: str) -> Optional[ToolSpec]:
        """Return the :class:`ToolSpec` for ``name``, or ``None`` if unknown."""
        return self._tools.get(name)

    # -- construction ------------------------------------------------------- #

    @classmethod
    def from_contract(cls, loaded: Optional[LoadedToolSchema] = None) -> "ToolSchema":
        """Build the schema from the imported AC-2 contract.

        Args:
            loaded: A pre-loaded contract document. If omitted, this calls
                :func:`agentcore.contracts.load_tool_schema`, which fails loudly
                if the contract artifact is absent (contracts are imported, never
                authored — there is no local fallback).
        """
        if loaded is None:
            loaded = load_tool_schema()
        return cls.from_document(loaded.schema)

    @classmethod
    def from_document(cls, document: Any) -> "ToolSchema":
        """Project a parsed AC-2 schema *document* into a :class:`ToolSchema`.

        Expected (structural) shape of the document — this mirrors the imported
        AC-2 contract; it is parsed here, never declared as the source of truth::

            {
              "tools": [
                {
                  "name": "book_appointment",
                  "arguments": {
                    "slot":    {"type": "string", "required": true},
                    "service": {"type": "string", "required": true},
                    "notes":   {"type": "string"}          # required defaults false
                  }
                },
                ...
              ]
            }

        Raises:
            MalformedToolSchemaError: the document does not match this shape or
                references an unknown argument type.
        """
        if not isinstance(document, Mapping):
            raise MalformedToolSchemaError(
                "AC-2 tool schema must be a JSON object with a 'tools' list"
            )
        raw_tools = document.get("tools")
        if not isinstance(raw_tools, list) or not raw_tools:
            raise MalformedToolSchemaError(
                "AC-2 tool schema must declare a non-empty 'tools' list"
            )

        tools: dict[str, ToolSpec] = {}
        for raw in raw_tools:
            if not isinstance(raw, Mapping):
                raise MalformedToolSchemaError("each tool must be a JSON object")
            name = raw.get("name")
            if not isinstance(name, str) or not name.strip():
                raise MalformedToolSchemaError("each tool must have a non-empty name")
            if name in tools:
                raise MalformedToolSchemaError(f"duplicate tool name {name!r}")

            raw_args = raw.get("arguments", {})
            if not isinstance(raw_args, Mapping):
                raise MalformedToolSchemaError(
                    f"tool {name!r} 'arguments' must be a JSON object"
                )

            arguments: dict[str, ArgumentSpec] = {}
            for arg_name, raw_spec in raw_args.items():
                if not isinstance(raw_spec, Mapping):
                    raise MalformedToolSchemaError(
                        f"argument {arg_name!r} of tool {name!r} must be an object"
                    )
                type_name = raw_spec.get("type")
                if type_name not in _JSON_TYPE_CHECKERS:
                    raise MalformedToolSchemaError(
                        f"argument {arg_name!r} of tool {name!r} has unsupported "
                        f"type {type_name!r}; supported: "
                        f"{sorted(_JSON_TYPE_CHECKERS)}"
                    )
                required = bool(raw_spec.get("required", False))
                arguments[arg_name] = ArgumentSpec(
                    name=arg_name, type_name=type_name, required=required
                )

            tools[name] = ToolSpec(name=name, arguments=arguments)

        return cls(tools)

    # -- validation --------------------------------------------------------- #

    def validate_invocation(self, invocation: "ToolInvocation") -> ToolSpec:
        """Validate ``invocation`` structurally; return the matched :class:`ToolSpec`.

        Checks run fail-closed in order: the tool name must be allowed, no
        undeclared argument may be present, every required argument must be
        present, and every present argument must match its declared type. The
        first failing check raises the specific :class:`ToolValidationError`.
        """
        spec = self._tools.get(invocation.tool)
        if spec is None:
            raise UnknownToolError(
                f'tool {invocation.tool!r} is not in the AC-2 tool schema '
                f"(allowed: {sorted(self._tools)})"
            )

        # No undeclared arguments may ride along.
        for arg_name in invocation.arguments:
            if arg_name not in spec.arguments:
                raise UnexpectedArgumentError(
                    f'tool {spec.name!r} does not declare argument {arg_name!r}'
                )

        # Every required argument must be present.
        for required in spec.required_arguments:
            if required not in invocation.arguments:
                raise MissingArgumentError(
                    f'tool {spec.name!r} requires argument {required!r}'
                )

        # Every present argument must match its declared type.
        for arg_name, value in invocation.arguments.items():
            arg_spec = spec.arguments[arg_name]
            if not arg_spec.matches_type(value):
                raise ArgumentTypeError(
                    f'argument {arg_name!r} of tool {spec.name!r} must be of '
                    f'type {arg_spec.type_name!r}, got {type(value).__name__}'
                )

        return spec


def build_test_tool_schema(tools: Mapping[str, Mapping[str, Any]]) -> ToolSchema:
    """Documented in-memory stand-in for the imported AC-2 schema, for tests.

    Use this when the real contract artifact is not present. ``tools`` maps a
    tool name to its argument map, where each argument maps to its spec::

        build_test_tool_schema(
            {
                "book_appointment": {
                    "slot":    {"type": "string", "required": True},
                    "service": {"type": "string", "required": True},
                    "notes":   {"type": "string"},
                },
                "place_order": {
                    "sku":      {"type": "string", "required": True},
                    "quantity": {"type": "integer", "required": True},
                },
            }
        )

    This produces the same :class:`ToolSchema` that
    :meth:`ToolSchema.from_contract` would for an equivalent contract document.
    """
    document = {
        "tools": [
            {"name": name, "arguments": dict(args)} for name, args in tools.items()
        ]
    }
    return ToolSchema.from_document(document)


# --------------------------------------------------------------------------- #
# Invocation + routed action models                                           #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ToolInvocation:
    """A reasoner-selected tool call to validate and route.

    Notably it carries **no tenant**: the operative tenant is always the
    session's validated tenant, never a field on the invocation/client payload
    (Requirement 7.4; steering ``multi-tenant-platform.md``).

    Attributes:
        tool: The tool name the reasoner selected.
        arguments: The tool arguments (values decoded from JSON).
    """

    tool: str
    arguments: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ToolAction:
    """The validated action routed to WF-1.

    Carries the validated tool name and arguments plus the trusted tenant the
    gateway stamped from the session. The tenant lives on the action so every
    downstream WF-1 step receives it (design Property 7).
    """

    tenant_id: str
    tool: str
    arguments: Mapping[str, Any]


# --------------------------------------------------------------------------- #
# Injectable WF-1 invoker                                                     #
# --------------------------------------------------------------------------- #


@runtime_checkable
class WorkflowInvoker(Protocol):
    """The WF-1 entry point the gateway routes to (``WF-1.start``).

    Kept abstract so the gateway is testable without Step Functions/EventBridge.
    A production adapter starts the WF-1 state machine (``StartExecution`` / the
    EventBridge bus) with the tenant and action; tests use a fake recorder.
    """

    def invoke(self, tenant_id: str, action: ToolAction) -> Any:
        """Start WF-1 for ``tenant_id`` with the validated ``action``."""
        ...


@runtime_checkable
class _SessionLike(Protocol):
    """Minimal session surface the gateway reads: just the validated tenant."""

    tenant_id: str


# --------------------------------------------------------------------------- #
# The gateway                                                                 #
# --------------------------------------------------------------------------- #


class ToolGateway:
    """AC-2 Tool Gateway: validate against AC-2 schema, then route to WF-1.

    Args:
        schema: The (injectable) AC-2 tool schema to validate against. Build it
            from the imported contract via :meth:`ToolSchema.from_contract`, or
            from :func:`build_test_tool_schema` when the contract is absent.
        workflow_invoker: The WF-1 entry point. The gateway calls
            ``invoke(session.tenant_id, action)`` only after validation passes.
    """

    def __init__(self, schema: ToolSchema, workflow_invoker: WorkflowInvoker) -> None:
        if not isinstance(schema, ToolSchema):
            raise MalformedToolSchemaError(
                "ToolGateway requires a ToolSchema (build it from the imported "
                "AC-2 contract or build_test_tool_schema)"
            )
        self._schema = schema
        self._invoker = workflow_invoker

    @property
    def schema(self) -> ToolSchema:
        return self._schema

    def invoke_tool(self, session: _SessionLike, invocation: ToolInvocation) -> Any:
        """Validate ``invocation`` and route it to WF-1 with the session tenant.

        Validation happens first: a non-conforming invocation raises a
        :class:`ToolValidationError` and **nothing is routed** (Property 11,
        Requirement 7.5). On success the gateway stamps ``session.tenant_id``
        (the validated tenant — never a client field, Requirement 7.4) onto the
        action and routes it to WF-1 (Requirement 7.3), returning the invoker's
        result.

        Raises:
            ToolValidationError: the invocation does not conform to the schema.
            ToolGatewayError: the session does not carry a usable tenant scope.
        """
        if not isinstance(invocation, ToolInvocation):
            raise ToolValidationError(
                "invocation must be a ToolInvocation"
            )

        tenant_id = getattr(session, "tenant_id", None)
        if not isinstance(tenant_id, str) or not tenant_id.strip():
            # The session is the sole tenant source; without it we route nothing.
            raise ToolGatewayError(
                "session does not carry a validated tenant; the gateway routes "
                "nothing without a session tenant"
            )

        # 1) Validate FIRST so a rejected invocation never reaches WF-1.
        self._schema.validate_invocation(invocation)

        # 2) Route to WF-1 with the tenant taken ONLY from the session context.
        action = ToolAction(
            tenant_id=tenant_id,
            tool=invocation.tool,
            arguments=dict(invocation.arguments),
        )
        return self._invoker.invoke(tenant_id, action)


__all__ = [
    # errors
    "ToolGatewayError",
    "MalformedToolSchemaError",
    "ToolValidationError",
    "UnknownToolError",
    "MissingArgumentError",
    "ArgumentTypeError",
    "UnexpectedArgumentError",
    # schema model
    "ArgumentSpec",
    "ToolSpec",
    "ToolSchema",
    "build_test_tool_schema",
    # invocation + action
    "ToolInvocation",
    "ToolAction",
    # invoker + gateway
    "WorkflowInvoker",
    "ToolGateway",
]
