"""Unit tests for the AC-2 Tool Gateway (task 10.1).

Example-based unit tests covering schema construction (from a contract document
and the test stand-in), structural validation of invocations, the
"validate-then-route / route-nothing-on-reject" behavior, and the rule that the
tenant routed to WF-1 always comes from the session — never the invocation. The
Property 11 property-based test is a separate task (10.2) and is not implemented
here.

Validates: Requirements 7.1, 7.3, 7.4, 7.5
"""

from __future__ import annotations

import pytest

from agentcore.gateway.tool_gateway import (
    ArgumentTypeError,
    MalformedToolSchemaError,
    MissingArgumentError,
    ToolAction,
    ToolGateway,
    ToolGatewayError,
    ToolInvocation,
    ToolSchema,
    ToolValidationError,
    UnexpectedArgumentError,
    UnknownToolError,
    WorkflowInvoker,
    build_test_tool_schema,
)
from agentcore.session.runtime import Session

TENANT = "tenant-abc"
OTHER_TENANT = "tenant-xyz"


# --------------------------------------------------------------------------- #
# Test doubles / fixtures                                                     #
# --------------------------------------------------------------------------- #


class RecordingInvoker:
    """A fake WF-1 invoker that records every routed (tenant, action) pair."""

    def __init__(self, result: object = "exec-arn") -> None:
        self.result = result
        self.calls: list[tuple[str, ToolAction]] = []

    def invoke(self, tenant_id: str, action: ToolAction) -> object:
        self.calls.append((tenant_id, action))
        return self.result


def make_schema() -> ToolSchema:
    return build_test_tool_schema(
        {
            "book_appointment": {
                "slot": {"type": "string", "required": True},
                "service": {"type": "string", "required": True},
                "notes": {"type": "string"},
            },
            "place_order": {
                "sku": {"type": "string", "required": True},
                "quantity": {"type": "integer", "required": True},
                "gift": {"type": "boolean"},
            },
        }
    )


def make_session(tenant_id: str = TENANT) -> Session:
    return Session(call_id="call-001", tenant_id=tenant_id, model_version="bedrock-v1")


def make_gateway(invoker: WorkflowInvoker | None = None) -> tuple[ToolGateway, RecordingInvoker]:
    rec = invoker or RecordingInvoker()
    return ToolGateway(make_schema(), rec), rec  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# Schema construction                                                         #
# --------------------------------------------------------------------------- #


def test_schema_from_document_projects_tools_and_required_args():
    schema = ToolSchema.from_document(
        {
            "tools": [
                {
                    "name": "book_appointment",
                    "arguments": {
                        "slot": {"type": "string", "required": True},
                        "notes": {"type": "string"},
                    },
                }
            ]
        }
    )
    assert schema.tool_names == frozenset({"book_appointment"})
    spec = schema.tool("book_appointment")
    assert spec is not None
    assert spec.required_arguments == ("slot",)


@pytest.mark.parametrize(
    "document",
    [
        "not-a-mapping",
        {},
        {"tools": []},
        {"tools": "nope"},
        {"tools": [{"arguments": {}}]},  # missing name
        {"tools": [{"name": ""}]},  # empty name
        {"tools": [{"name": "t", "arguments": "bad"}]},  # args not a map
        {"tools": [{"name": "t", "arguments": {"a": {"type": "weird"}}}]},  # bad type
        {"tools": [{"name": "dup"}, {"name": "dup"}]},  # duplicate
    ],
)
def test_malformed_schema_document_is_rejected(document):
    with pytest.raises(MalformedToolSchemaError):
        ToolSchema.from_document(document)


def test_build_test_tool_schema_matches_equivalent_document():
    via_helper = build_test_tool_schema(
        {"ping": {"msg": {"type": "string", "required": True}}}
    )
    via_doc = ToolSchema.from_document(
        {"tools": [{"name": "ping", "arguments": {"msg": {"type": "string", "required": True}}}]}
    )
    assert via_helper.tool_names == via_doc.tool_names
    assert via_helper.tool("ping").required_arguments == ("msg",)


# --------------------------------------------------------------------------- #
# Happy path: valid invocation routes to WF-1 with the session tenant         #
# --------------------------------------------------------------------------- #


def test_valid_invocation_routes_to_wf1_with_session_tenant():
    gateway, rec = make_gateway()
    invocation = ToolInvocation(
        tool="book_appointment",
        arguments={"slot": "2025-01-02T10:00", "service": "hvac-tuneup"},
    )

    result = gateway.invoke_tool(make_session(), invocation)

    assert result == "exec-arn"
    assert len(rec.calls) == 1
    tenant_id, action = rec.calls[0]
    assert tenant_id == TENANT
    assert isinstance(action, ToolAction)
    assert action.tenant_id == TENANT
    assert action.tool == "book_appointment"
    assert action.arguments == {"slot": "2025-01-02T10:00", "service": "hvac-tuneup"}


def test_optional_argument_may_be_omitted_or_present():
    gateway, rec = make_gateway()
    gateway.invoke_tool(
        make_session(),
        ToolInvocation(tool="book_appointment", arguments={"slot": "s", "service": "v"}),
    )
    gateway.invoke_tool(
        make_session(),
        ToolInvocation(
            tool="book_appointment",
            arguments={"slot": "s", "service": "v", "notes": "leave at door"},
        ),
    )
    assert len(rec.calls) == 2


def test_integer_argument_accepts_int_but_not_bool():
    gateway, rec = make_gateway()
    gateway.invoke_tool(
        make_session(),
        ToolInvocation(tool="place_order", arguments={"sku": "x", "quantity": 3}),
    )
    assert rec.calls[-1][1].arguments["quantity"] == 3

    with pytest.raises(ArgumentTypeError):
        gateway.invoke_tool(
            make_session(),
            ToolInvocation(tool="place_order", arguments={"sku": "x", "quantity": True}),
        )


def test_tenant_is_taken_from_session_not_invocation_arguments():
    gateway, rec = make_gateway()
    # Even if a client tries to smuggle a tenant via args, the routed tenant is
    # the session's. (tenant_id isn't a declared arg, so it's also rejected as
    # unexpected — proving the invocation can't introduce a tenant at all.)
    with pytest.raises(UnexpectedArgumentError):
        gateway.invoke_tool(
            make_session(),
            ToolInvocation(
                tool="book_appointment",
                arguments={"slot": "s", "service": "v", "tenant_id": "attacker"},
            ),
        )
    assert rec.calls == []


def test_two_sessions_route_their_own_tenant():
    gateway, rec = make_gateway()
    inv = ToolInvocation(tool="book_appointment", arguments={"slot": "s", "service": "v"})
    gateway.invoke_tool(make_session(TENANT), inv)
    gateway.invoke_tool(make_session(OTHER_TENANT), inv)
    assert [t for t, _ in rec.calls] == [TENANT, OTHER_TENANT]


# --------------------------------------------------------------------------- #
# Rejection: non-conforming invocation routes NOTHING (Property 11 examples)  #
# --------------------------------------------------------------------------- #


def test_unknown_tool_is_rejected_and_routes_nothing():
    gateway, rec = make_gateway()
    with pytest.raises(UnknownToolError):
        gateway.invoke_tool(
            make_session(), ToolInvocation(tool="launch_missiles", arguments={})
        )
    assert rec.calls == []


def test_missing_required_argument_is_rejected_and_routes_nothing():
    gateway, rec = make_gateway()
    with pytest.raises(MissingArgumentError):
        gateway.invoke_tool(
            make_session(),
            ToolInvocation(tool="book_appointment", arguments={"slot": "s"}),
        )
    assert rec.calls == []


def test_wrong_argument_type_is_rejected_and_routes_nothing():
    gateway, rec = make_gateway()
    with pytest.raises(ArgumentTypeError):
        gateway.invoke_tool(
            make_session(),
            ToolInvocation(
                tool="book_appointment", arguments={"slot": 123, "service": "v"}
            ),
        )
    assert rec.calls == []


def test_unexpected_argument_is_rejected_and_routes_nothing():
    gateway, rec = make_gateway()
    with pytest.raises(UnexpectedArgumentError):
        gateway.invoke_tool(
            make_session(),
            ToolInvocation(
                tool="book_appointment",
                arguments={"slot": "s", "service": "v", "surprise": "x"},
            ),
        )
    assert rec.calls == []


def test_validation_errors_share_a_common_base_type():
    gateway, rec = make_gateway()
    # Every rejection is a ToolValidationError so callers can catch one type.
    with pytest.raises(ToolValidationError):
        gateway.invoke_tool(
            make_session(), ToolInvocation(tool="nope", arguments={})
        )
    assert rec.calls == []


# --------------------------------------------------------------------------- #
# Rejection: no session tenant => route nothing                               #
# --------------------------------------------------------------------------- #


def test_missing_session_tenant_routes_nothing():
    gateway, rec = make_gateway()
    no_tenant = type("Bare", (), {"tenant_id": ""})()
    with pytest.raises(ToolGatewayError):
        gateway.invoke_tool(
            no_tenant,
            ToolInvocation(tool="book_appointment", arguments={"slot": "s", "service": "v"}),
        )
    assert rec.calls == []


# --------------------------------------------------------------------------- #
# Construction guards                                                         #
# --------------------------------------------------------------------------- #


def test_gateway_requires_a_tool_schema():
    with pytest.raises(MalformedToolSchemaError):
        ToolGateway(object(), RecordingInvoker())  # type: ignore[arg-type]
