/**
 * Imported-contract loaders (TypeScript).
 *
 * Boundary contracts are **imported, never authored** (see steering
 * `tech-and-structure.md` and design.md "Scope"). This module LOADS the
 * boundary artifacts published by the `@alchemist/contracts` package and
 * surfaces them, typed, to the CDK stacks and Lambdas:
 *
 *   - CP-2 REST contract     -> `openapi.yaml`            (loadOpenApiSpec)
 *   - CP-3 AppSync SDL        -> `graphql/schema.graphql`  (loadGraphqlSdl)
 *   - AC-2 tool schema        -> tool schema JSON          (loadToolSchema)
 *   - SE-1 voice-edge proto   -> `*.proto`                 (loadSe1Proto)
 *
 * These helpers NEVER re-declare or vendor the contract types. They only read
 * bytes from the resolved contracts package. If the package or an individual
 * artifact cannot be found, they FAIL LOUDLY with a typed error rather than
 * falling back to a locally-authored copy.
 *
 * ## Pointing the loaders at the real contracts package
 *
 * Resolution happens in this order:
 *
 *   1. `ALCHEMIST_CONTRACTS_DIR` env var — an absolute (or cwd-relative) path
 *      to the root of the contracts artifacts. Use this when the package is
 *      not yet published/linked into `node_modules` (e.g. a sibling checkout):
 *
 *          export ALCHEMIST_CONTRACTS_DIR=/path/to/alchemist-contracts
 *
 *   2. Node package resolution of `@alchemist/contracts` — used once the
 *      package is published or `npm link`ed. The artifacts are read relative
 *      to the resolved package root.
 *
 * Individual artifact locations within the package can be overridden with the
 * per-artifact env vars documented on {@link ArtifactSpec.envOverride} below,
 * for the (rare) case the contracts package reorganizes its layout.
 */

import * as fs from 'fs';
import * as path from 'path';

/** npm package name of the imported boundary contracts. */
export const CONTRACTS_PACKAGE = '@alchemist/contracts';

/** Env var that points the loaders at a contracts artifacts root on disk. */
export const CONTRACTS_DIR_ENV = 'ALCHEMIST_CONTRACTS_DIR';

/**
 * Raised when the contracts package / artifacts root cannot be located at all.
 * This is intentionally distinct from {@link MissingContractArtifactError}: it
 * means "we don't know where the contracts live", not "a specific file is
 * missing".
 */
export class ContractResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractResolutionError';
  }
}

/**
 * Raised when the contracts root is known but a specific artifact file is
 * absent. The loaders NEVER substitute a local copy — a missing artifact is a
 * hard failure.
 */
export class MissingContractArtifactError extends Error {
  /** The artifact's logical name (e.g. "CP-2 openapi.yaml"). */
  readonly artifact: string;
  /** The absolute path that was checked. */
  readonly checkedPath: string;

  constructor(artifact: string, checkedPath: string, hint: string) {
    super(
      `Imported contract artifact "${artifact}" was not found at ${checkedPath}. ` +
        `Contracts are imported, never authored — no local fallback is used. ${hint}`,
    );
    this.name = 'MissingContractArtifactError';
    this.artifact = artifact;
    this.checkedPath = checkedPath;
  }
}

/** Describes one boundary artifact and how to locate it within the package. */
interface ArtifactSpec {
  /** Logical name used in errors. */
  readonly name: string;
  /** Default path of the artifact relative to the contracts package root. */
  readonly defaultRelPath: string;
  /** Env var that overrides {@link defaultRelPath} if the layout changes. */
  readonly envOverride: string;
}

const ARTIFACTS = {
  openapi: {
    name: 'CP-2 openapi.yaml',
    defaultRelPath: 'openapi.yaml',
    envOverride: 'ALCHEMIST_CONTRACTS_OPENAPI',
  },
  graphql: {
    name: 'CP-3 graphql/schema.graphql',
    defaultRelPath: 'graphql/schema.graphql',
    envOverride: 'ALCHEMIST_CONTRACTS_GRAPHQL',
  },
  toolSchema: {
    name: 'AC-2 tool schema',
    defaultRelPath: 'ac2/tool-schema.json',
    envOverride: 'ALCHEMIST_CONTRACTS_TOOL_SCHEMA',
  },
  se1Proto: {
    name: 'SE-1 proto',
    defaultRelPath: 'se1/se1.proto',
    envOverride: 'ALCHEMIST_CONTRACTS_SE1_PROTO',
  },
} as const satisfies Record<string, ArtifactSpec>;

/** Common shape returned by every loader: where it came from + its bytes. */
export interface LoadedArtifact {
  /** Absolute path the artifact was resolved and read from. */
  readonly path: string;
  /** Raw UTF-8 contents of the artifact, exactly as published. */
  readonly raw: string;
}

/** Result of {@link loadOpenApiSpec}. */
export interface LoadedOpenApiSpec extends LoadedArtifact {}

/** Result of {@link loadGraphqlSdl}: the AppSync SDL string. */
export interface LoadedGraphqlSdl extends LoadedArtifact {
  /** The GraphQL SDL text (alias of {@link LoadedArtifact.raw}). */
  readonly sdl: string;
}

/** Result of {@link loadToolSchema}: raw JSON plus the parsed document. */
export interface LoadedToolSchema extends LoadedArtifact {
  /**
   * The parsed AC-2 tool schema document. Typed as `unknown` on purpose: this
   * module imports the contract, it does not re-declare its shape. Consumers
   * validate/narrow against the imported schema themselves.
   */
  readonly schema: unknown;
}

/** Result of {@link loadSe1Proto}: the protobuf IDL source. */
export interface LoadedSe1Proto extends LoadedArtifact {
  /** The `.proto` source text (alias of {@link LoadedArtifact.raw}). */
  readonly proto: string;
}

/**
 * Resolve the root directory that holds the imported contract artifacts.
 *
 * @throws {ContractResolutionError} if neither the env override nor package
 *   resolution can locate the contracts.
 */
export function resolveContractsRoot(): string {
  const envDir = process.env[CONTRACTS_DIR_ENV];
  if (envDir && envDir.trim() !== '') {
    const resolved = path.resolve(envDir);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new ContractResolutionError(
        `${CONTRACTS_DIR_ENV} is set to "${envDir}" but no such directory exists ` +
          `(resolved to ${resolved}). Point it at the root of the ${CONTRACTS_PACKAGE} artifacts.`,
      );
    }
    return resolved;
  }

  try {
    // Resolve the package root via its package.json so we get a directory.
    const pkgJson = require.resolve(`${CONTRACTS_PACKAGE}/package.json`);
    return path.dirname(pkgJson);
  } catch {
    throw new ContractResolutionError(
      `Could not resolve the imported contracts. Either install/link ` +
        `${CONTRACTS_PACKAGE} so it is resolvable from node_modules, or set ` +
        `${CONTRACTS_DIR_ENV} to the directory containing the contract artifacts ` +
        `(openapi.yaml, graphql/schema.graphql, the AC-2 tool schema, and the SE-1 proto). ` +
        `Contracts are imported, never authored — there is no local fallback.`,
    );
  }
}

/** Resolve an artifact's absolute path, honoring its per-artifact env override. */
function artifactPath(spec: ArtifactSpec): string {
  const root = resolveContractsRoot();
  const rel = process.env[spec.envOverride]?.trim() || spec.defaultRelPath;
  return path.resolve(root, rel);
}

/** Read an artifact file or fail loudly with a typed, actionable error. */
function readArtifact(spec: ArtifactSpec): LoadedArtifact {
  const abs = artifactPath(spec);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new MissingContractArtifactError(
      spec.name,
      abs,
      `Ensure the ${CONTRACTS_PACKAGE} package publishes it, or override its location with ` +
        `${spec.envOverride} / ${CONTRACTS_DIR_ENV}.`,
    );
  }
  return { path: abs, raw: fs.readFileSync(abs, 'utf8') };
}

/**
 * Load the CP-2 REST contract (`openapi.yaml`) from the contracts package.
 * The raw text is suitable for CDK `apigateway.ApiDefinition.fromAsset(path)`
 * (use {@link LoadedOpenApiSpec.path}) or for callers that parse it themselves.
 */
export function loadOpenApiSpec(): LoadedOpenApiSpec {
  return readArtifact(ARTIFACTS.openapi);
}

/**
 * Load the CP-3 AppSync SDL (`graphql/schema.graphql`) from the contracts
 * package. The SDL is the single source of truth for the CP-3 types — it is
 * loaded here, never re-authored in CDK.
 */
export function loadGraphqlSdl(): LoadedGraphqlSdl {
  const { path: p, raw } = readArtifact(ARTIFACTS.graphql);
  return { path: p, raw, sdl: raw };
}

/**
 * Load and parse the AC-2 tool schema (JSON) from the contracts package.
 *
 * @throws {MissingContractArtifactError} if the artifact is absent.
 * @throws {SyntaxError} if the artifact exists but is not valid JSON.
 */
export function loadToolSchema(): LoadedToolSchema {
  const { path: p, raw } = readArtifact(ARTIFACTS.toolSchema);
  const schema: unknown = JSON.parse(raw);
  return { path: p, raw, schema };
}

/**
 * Load the SE-1 proto IDL source from the contracts package. The returned
 * `proto` text is suitable for proto tooling / asset bundling.
 */
export function loadSe1Proto(): LoadedSe1Proto {
  const { path: p, raw } = readArtifact(ARTIFACTS.se1Proto);
  return { path: p, raw, proto: raw };
}
