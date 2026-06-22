"""Placeholder test confirming pytest + hypothesis are wired up for AgentCore.

Real property tests (minimum 100 iterations, tagged
`Feature: aws-backend, Property {n}: ...`) are added by the `*` test sub-tasks.
"""

from hypothesis import given, settings
from hypothesis import strategies as st

import agentcore


def test_agentcore_importable():
    assert agentcore.__version__ == "0.1.0"


@settings(max_examples=100)
@given(st.integers(), st.integers())
def test_hypothesis_runs(a, b):
    # Smoke property: integer addition is commutative.
    assert a + b == b + a
