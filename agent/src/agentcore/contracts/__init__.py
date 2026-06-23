"""Imported-contract loaders (Python).

Boundary contracts are **imported, never authored** (see steering
``tech-and-structure.md`` and design.md "Scope"). This module LOADS the
boundary artifacts published by the ``alchemist_contracts`` package and
surfaces them, typed, to the AgentCore Lambdas:

  - CP-2 REST contract    -> ``openapi.yaml``            (:func:`load_openapi_spec`)
  - CP-3 AppSync SDL       -> ``graphql/schema.graphql``  (:func:`load_graphql_sdl`)
  - AC-2 tool schema       -> tool schema JSON            (:func:`load_tool_schema`)
  - SE-1 voice-edge proto  -> ``*.proto``                 (:func:`load_se1_proto`)

These helpers NEVER re-declare or vendor the contract types. They only read
bytes from the resolved contracts package. If the package or an individual
artifact cannot be found, they FAIL LOUDLY with a typed error rather than
falling back to a locally-authored copy.

Pointing the loaders at the real contracts package
---------------------------------------------------
Resolution happens in this order:

1. ``ALCHEMIST_CONTRACTS_DIR`` env var — a filesystem path to the root of the
   contracts artifacts. Use this when the package is not yet published/installed
   (e.g. a sibling checkout)::

       export ALCHEMIST_CONTRACTS_DIR=/path/to/alchemist-contracts

2. Python package resolution of ``alchemist_contracts`` — used once the package
   is installed/importable. Artifacts are read relative to the package dir.

Individual artifact locations within the package can be overridden with the
per-artifact env vars (e.g. ``ALCHEMIST_CONTRACTS_OPENAPI``) for the rare case
the contracts package reorganizes its layout.
"""

from __future__ import annotations

import importlib.util
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# --------------------------------------------------------------------------- #
# Generated boundary message types — imported, never authored.                #
# --------------------------------------------------------------------------- #
# The generated protobuf shapes (SE-1 wire, AC-2 tools, CP-2/CP-3 domain) are
# re-exported here so the rest of AgentCore imports them from one place and uses
# the SAME generated code the middleware sends over SE-1. These are distinct
# from the artifact *loaders* below (which read the shipped openapi/graphql/proto
# files); both surfaces are intentionally provided.
from alchemist_contracts import ac2, domain, se1  # noqa: F401  re-export

try:  # gRPC service stubs (grpcio is a transitive dep; guard just in case)
    from alchemist_contracts import ac2_grpc, se1_grpc  # noqa: F401  re-export
except ImportError:  # pragma: no cover - grpcio not installed
    ac2_grpc = None
    se1_grpc = None

#: Distribution/package name of the imported boundary contracts.
CONTRACTS_PACKAGE = "alchemist_contracts"

#: Env var that points the loaders at a contracts artifacts root on disk.
CONTRACTS_DIR_ENV = "ALCHEMIST_CONTRACTS_DIR"


class ContractResolutionError(RuntimeError):
    """Raised when the contracts package / artifacts root cannot be located.

    Distinct from :class:`MissingContractArtifactError`: it means "we don't
    know where the contracts live", not "a specific file is missing".
    """


class MissingContractArtifactError(FileNotFoundError):
    """Raised when the contracts root is known but a specific artifact is absent.

    The loaders NEVER substitute a local copy — a missing artifact is a hard
    failure.
    """

    def __init__(self, artifact: str, checked_path: Path, hint: str) -> None:
        self.artifact = artifact
        self.checked_path = checked_path
        super().__init__(
            f'Imported contract artifact "{artifact}" was not found at '
            f"{checked_path}. Contracts are imported, never authored — no local "
            f"fallback is used. {hint}"
        )


@dataclass(frozen=True)
class _ArtifactSpec:
    """Describes one boundary artifact and how to locate it in the package."""

    name: str  # logical name used in errors
    default_rel_path: str  # path relative to the contracts package root
    env_override: str  # env var that overrides ``default_rel_path``


_ARTIFACTS = {
    "openapi": _ArtifactSpec(
        "CP-2 openapi.yaml", "openapi.yaml", "ALCHEMIST_CONTRACTS_OPENAPI"
    ),
    "graphql": _ArtifactSpec(
        "CP-3 graphql/schema.graphql",
        "graphql/schema.graphql",
        "ALCHEMIST_CONTRACTS_GRAPHQL",
    ),
    "tool_schema": _ArtifactSpec(
        "AC-2 tool schema", "ac2/tool-schema.json", "ALCHEMIST_CONTRACTS_TOOL_SCHEMA"
    ),
    "se1_proto": _ArtifactSpec(
        "SE-1 proto", "se1/se1.proto", "ALCHEMIST_CONTRACTS_SE1_PROTO"
    ),
}


@dataclass(frozen=True)
class LoadedArtifact:
    """Common result: where the artifact came from + its bytes."""

    path: Path
    raw: str


@dataclass(frozen=True)
class LoadedOpenApiSpec(LoadedArtifact):
    """Result of :func:`load_openapi_spec` (the CP-2 ``openapi.yaml`` text)."""


@dataclass(frozen=True)
class LoadedGraphqlSdl(LoadedArtifact):
    """Result of :func:`load_graphql_sdl`."""

    @property
    def sdl(self) -> str:
        """The GraphQL SDL text (alias of :attr:`raw`)."""
        return self.raw


@dataclass(frozen=True)
class LoadedToolSchema(LoadedArtifact):
    """Result of :func:`load_tool_schema`: raw JSON plus the parsed document.

    ``schema`` is typed as ``Any`` on purpose: this module imports the contract,
    it does not re-declare its shape. Consumers validate/narrow themselves.
    """

    schema: Any = None


@dataclass(frozen=True)
class LoadedSe1Proto(LoadedArtifact):
    """Result of :func:`load_se1_proto`: the protobuf IDL source."""

    @property
    def proto(self) -> str:
        """The ``.proto`` source text (alias of :attr:`raw`)."""
        return self.raw


def resolve_contracts_root() -> Path:
    """Resolve the root directory holding the imported contract artifacts.

    Raises:
        ContractResolutionError: if neither the env override nor package
            resolution can locate the contracts.
    """
    env_dir = os.environ.get(CONTRACTS_DIR_ENV, "").strip()
    if env_dir:
        resolved = Path(env_dir).resolve()
        if not resolved.is_dir():
            raise ContractResolutionError(
                f'{CONTRACTS_DIR_ENV} is set to "{env_dir}" but no such directory '
                f"exists (resolved to {resolved}). Point it at the root of the "
                f"{CONTRACTS_PACKAGE} artifacts."
            )
        return resolved

    try:
        spec = importlib.util.find_spec(CONTRACTS_PACKAGE)
    except (ImportError, ValueError):
        spec = None

    if spec is not None:
        # Regular package: origin is .../alchemist_contracts/__init__.py
        if spec.origin and spec.origin != "namespace":
            return Path(spec.origin).resolve().parent
        # Namespace package: use the first search location.
        if spec.submodule_search_locations:
            return Path(next(iter(spec.submodule_search_locations))).resolve()

    raise ContractResolutionError(
        f"Could not resolve the imported contracts. Either install "
        f"{CONTRACTS_PACKAGE} so it is importable, or set {CONTRACTS_DIR_ENV} to "
        f"the directory containing the contract artifacts (openapi.yaml, "
        f"graphql/schema.graphql, the AC-2 tool schema, and the SE-1 proto). "
        f"Contracts are imported, never authored — there is no local fallback."
    )


def _artifact_path(spec: _ArtifactSpec) -> Path:
    """Resolve an artifact's absolute path, honoring its per-artifact override."""
    root = resolve_contracts_root()
    rel = os.environ.get(spec.env_override, "").strip() or spec.default_rel_path
    return (root / rel).resolve()


def _read_artifact(spec: _ArtifactSpec) -> LoadedArtifact:
    """Read an artifact file or fail loudly with a typed, actionable error."""
    abs_path = _artifact_path(spec)
    if not abs_path.is_file():
        raise MissingContractArtifactError(
            spec.name,
            abs_path,
            f"Ensure the {CONTRACTS_PACKAGE} package ships it, or override its "
            f"location with {spec.env_override} / {CONTRACTS_DIR_ENV}.",
        )
    return LoadedArtifact(path=abs_path, raw=abs_path.read_text(encoding="utf-8"))


def load_openapi_spec() -> LoadedOpenApiSpec:
    """Load the CP-2 REST contract (``openapi.yaml``) from the contracts package."""
    loaded = _read_artifact(_ARTIFACTS["openapi"])
    return LoadedOpenApiSpec(path=loaded.path, raw=loaded.raw)


def load_graphql_sdl() -> LoadedGraphqlSdl:
    """Load the CP-3 AppSync SDL (``graphql/schema.graphql``).

    The SDL is the single source of truth for CP-3 types — loaded here, never
    re-authored.
    """
    loaded = _read_artifact(_ARTIFACTS["graphql"])
    return LoadedGraphqlSdl(path=loaded.path, raw=loaded.raw)


def load_tool_schema() -> LoadedToolSchema:
    """Load and parse the AC-2 tool schema (JSON).

    Raises:
        MissingContractArtifactError: if the artifact is absent.
        json.JSONDecodeError: if the artifact exists but is not valid JSON.
    """
    loaded = _read_artifact(_ARTIFACTS["tool_schema"])
    return LoadedToolSchema(
        path=loaded.path, raw=loaded.raw, schema=json.loads(loaded.raw)
    )


def load_se1_proto() -> LoadedSe1Proto:
    """Load the SE-1 proto IDL source from the contracts package."""
    loaded = _read_artifact(_ARTIFACTS["se1_proto"])
    return LoadedSe1Proto(path=loaded.path, raw=loaded.raw)


__all__ = [
    # generated boundary message types (re-exported from alchemist_contracts)
    "se1",
    "ac2",
    "domain",
    "se1_grpc",
    "ac2_grpc",
    "CONTRACTS_PACKAGE",
    "CONTRACTS_DIR_ENV",
    "ContractResolutionError",
    "MissingContractArtifactError",
    "LoadedArtifact",
    "LoadedOpenApiSpec",
    "LoadedGraphqlSdl",
    "LoadedToolSchema",
    "LoadedSe1Proto",
    "resolve_contracts_root",
    "load_openapi_spec",
    "load_graphql_sdl",
    "load_tool_schema",
    "load_se1_proto",
]
