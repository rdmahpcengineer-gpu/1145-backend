"""CI guard: the AgentCore side of the SE-1 seam is version-pinned.

If alchemist-contracts resolves to anything but the pinned 0.1.0, fail loudly —
the backend receiving end must decode the SAME generated wire types the
middleware sends.
"""

import importlib.metadata as metadata


def test_alchemist_contracts_pinned_to_seam_version():
    assert metadata.version("alchemist-contracts") == "0.1.0"


def test_se1_wire_types_reexported_from_contracts_module():
    # agentcore.contracts re-exports the generated boundary types.
    from agentcore.contracts import se1, ac2, domain, se1_grpc

    assert se1.Utterance.DESCRIPTOR.full_name == "alchemist.v0.Utterance"
    assert hasattr(se1_grpc, "Se1BridgeServicer")
    assert ac2 is not None and domain is not None
