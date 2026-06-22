/**
 * CP-2 OpenAPI spec resolution (with synth-resilient fallback).
 *
 * The CP-2 REST API is built FROM the imported `openapi.yaml` contract — the
 * repository never authors or re-declares the contract (R2.2; steering
 * `tech-and-structure.md`: "Contracts are imported, not declared."). The single
 * source of truth is the `@alchemist/contracts` package, loaded via
 * {@link loadOpenApiSpec}.
 *
 * That package may not be present in every checkout (it lives in a separate
 * repo and is out of scope here). To keep `cdk synth` and the tests runnable in
 * that situation, resolution falls back, in order:
 *
 *   1. An explicitly injected spec path (`specPath`) — highest priority. Lets a
 *      caller/test point at any spec on disk.
 *   2. The imported contract via {@link loadOpenApiSpec} (the real source).
 *   3. The bundled LOCAL TEST FIXTURE under `__fixtures__/openapi.yaml`.
 *
 * The fixture is a deliberately minimal STAND-IN used ONLY so synth/tests can
 * run when the real contract is absent. It is clearly labelled as such and is
 * NEVER the source of truth — see `__fixtures__/openapi.yaml`. Callers are told
 * which origin was used via {@link ResolvedOpenApi.origin} so the fixture path
 * can be surfaced as a synth warning.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ContractResolutionError,
  MissingContractArtifactError,
  loadOpenApiSpec,
} from '../../shared/contracts';

/** Absolute path to the bundled CP-2 OpenAPI test fixture (stand-in only). */
export const FIXTURE_OPENAPI_PATH = path.join(
  __dirname,
  '__fixtures__',
  'openapi.yaml',
);

/** Where a resolved CP-2 spec came from. */
export type OpenApiOrigin =
  /** The imported `@alchemist/contracts` `openapi.yaml` — the source of truth. */
  | 'imported-contract'
  /** An explicitly injected spec path (e.g. a test or alternate checkout). */
  | 'injected-path'
  /** The bundled local stand-in fixture (real contract was unresolvable). */
  | 'test-fixture';

/** A resolved CP-2 OpenAPI spec: its bytes, on-disk path, and origin. */
export interface ResolvedOpenApi {
  /** Absolute path the spec was read from. */
  readonly path: string;
  /** Raw spec text (YAML or JSON), exactly as read. */
  readonly raw: string;
  /** Which resolution branch produced this spec. */
  readonly origin: OpenApiOrigin;
}

/** Options controlling {@link resolveOpenApiSpec}. */
export interface ResolveOpenApiOptions {
  /**
   * Explicit path to an OpenAPI spec. When set, it is used directly and takes
   * precedence over the imported contract — the injection point that keeps
   * synth/tests runnable without the contracts package.
   */
  readonly specPath?: string;
  /**
   * Whether to fall back to the bundled local test fixture when the imported
   * contract cannot be resolved. Defaults to `true` so a fresh checkout (no
   * contracts package) still synthesizes. Set `false` to require the real
   * contract and fail loudly otherwise.
   */
  readonly allowFixtureFallback?: boolean;
}

function readSpecFile(specPath: string): string {
  if (!fs.existsSync(specPath) || !fs.statSync(specPath).isFile()) {
    throw new Error(
      `CP-2 OpenAPI spec was not found at ${specPath}. ` +
        `Provide a valid spec path or install/link @alchemist/contracts.`,
    );
  }
  return fs.readFileSync(specPath, 'utf8');
}

/**
 * Resolve the CP-2 OpenAPI spec, preferring the imported contract and falling
 * back to an injected path or the local fixture so synth/tests stay runnable.
 *
 * @throws when the imported contract is unresolvable AND fixture fallback is
 *   disabled (re-raises the underlying contract resolution error).
 */
export function resolveOpenApiSpec(
  opts: ResolveOpenApiOptions = {},
): ResolvedOpenApi {
  // 1. Explicit injected path wins.
  if (opts.specPath) {
    return {
      path: opts.specPath,
      raw: readSpecFile(opts.specPath),
      origin: 'injected-path',
    };
  }

  // 2. The imported contract — the source of truth.
  try {
    const imported = loadOpenApiSpec();
    return {
      path: imported.path,
      raw: imported.raw,
      origin: 'imported-contract',
    };
  } catch (err) {
    const isResolutionMiss =
      err instanceof ContractResolutionError ||
      err instanceof MissingContractArtifactError;
    if (!isResolutionMiss) {
      // A real, unexpected error (e.g. permission/IO) — never mask it.
      throw err;
    }

    // 3. Local stand-in fixture so synth/tests can run without the contract.
    const allowFixture = opts.allowFixtureFallback ?? true;
    if (!allowFixture) {
      throw err;
    }
    return {
      path: FIXTURE_OPENAPI_PATH,
      raw: readSpecFile(FIXTURE_OPENAPI_PATH),
      origin: 'test-fixture',
    };
  }
}
