/// <reference path="./js-yaml.d.ts" />
import { Annotations, aws_apigateway as apigateway } from 'aws-cdk-lib';
import { Construct } from 'constructs';
// `js-yaml` ships no bundled types and `@types/js-yaml` is not installed; the
// reference directive at the top of this file pulls in the local ambient
// declaration when compiled standalone (e.g. via ts-node during `cdk synth`).
import * as yaml from 'js-yaml';
import { WiringKeys, publishWiring } from '../../shared/wiring';
import { TenantUserPool } from '../cognito/tenant-user-pool';
import {
  OpenApiOrigin,
  ResolvedOpenApi,
  resolveOpenApiSpec,
} from './openapi-source';

/**
 * Name of the security scheme injected into the imported spec that binds every
 * CP-2 method to the CP-1 Cognito user pool.
 */
export const CP1_AUTHORIZER_SCHEME = 'Cp1CognitoUserPools';

/** Name of the request validator injected to enable spec-driven validation. */
export const CP2_REQUEST_VALIDATOR = 'cp2-validate-body-and-params';

/** HTTP operation keys that may appear under an OpenAPI path item. */
const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
] as const;

/**
 * RestCommandApi — CP-2 API Gateway REST command API.
 *
 * Provisions the CP-2 REST API as an API Gateway **`SpecRestApi` built FROM the
 * imported `openapi.yaml`** (design.md "CP-2"). The repository never declares
 * paths, models, or schemas locally — the imported contract is the single
 * source of truth (R2.1, R2.2). The spec is resolved by {@link resolveOpenApiSpec}
 * (imported contract, with a synth-resilient fallback to a local stand-in
 * fixture when the `@alchemist/contracts` package is not present).
 *
 * Two cross-cutting controls are injected into the imported spec at synth time
 * — neither declares any path/model/schema, they only attach controls to what
 * the contract already defines:
 *
 *  - **CP-1 Cognito authorization (R2.3).** A `cognito_user_pools` authorizer
 *    bound to the CP-1 tenant/operator pool is registered as a security scheme
 *    and applied to **every** method (root default + per-operation), so no CP-2
 *    request reaches an integration without a CP-1 Validated_Session. (SpecRestApi
 *    binds authorizers through the OpenAPI security definitions rather than the
 *    method-level `CognitoUserPoolsAuthorizer` construct; the same CP-1 pool from
 *    {@link TenantUserPool} backs both paths.)
 *  - **Spec-driven request validation (R2.6).** A request validator that checks
 *    the request body and parameters is enabled globally, so requests that do
 *    not conform to the models declared in the imported `openapi.yaml` are
 *    rejected with a validation error before any integration runs.
 *
 * Handlers (task 6.2) derive `tenantId` from the authorizer context and route
 * fulfillment to WF-1; that wiring is intentionally out of scope here. The REST
 * API id and root resource id are exported via shared/wiring for those consumers.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.6
 */
export interface RestCommandApiProps {
  /** CP-1 tenant/operator pool that authorizes every CP-2 method. */
  readonly tenantUserPool: TenantUserPool;
  /**
   * Explicit OpenAPI spec path. When omitted, the imported contract is used,
   * falling back to the local fixture (see {@link resolveOpenApiSpec}).
   */
  readonly openApiSpecPath?: string;
  /**
   * Allow falling back to the bundled local test fixture when the imported
   * contract is unresolvable. Defaults to `true`.
   */
  readonly allowFixtureFallback?: boolean;
  /** Optional REST API name. */
  readonly restApiName?: string;
}

export class RestCommandApi extends Construct {
  /** The CP-2 REST API, built from the imported (or fixture) OpenAPI spec. */
  readonly restApi: apigateway.SpecRestApi;

  /** Convenience accessor for cross-stack consumers (command handlers). */
  readonly restApiId: string;

  /** Root resource id, exported for handler/integration wiring. */
  readonly rootResourceId: string;

  /** Which spec source backed this API (imported contract vs fixture). */
  readonly specOrigin: OpenApiOrigin;

  constructor(scope: Construct, id: string, props: RestCommandApiProps) {
    super(scope, id);

    const resolved = resolveOpenApiSpec({
      specPath: props.openApiSpecPath,
      allowFixtureFallback: props.allowFixtureFallback,
    });
    this.specOrigin = resolved.origin;

    if (resolved.origin === 'test-fixture') {
      // Make it unmistakable that the real contract was NOT used. The fixture
      // is a stand-in for synth/tests only and is never the source of truth.
      Annotations.of(this).addWarning(
        `CP-2 REST API was built from the LOCAL TEST FIXTURE (${resolved.path}), ` +
          `not the imported @alchemist/contracts openapi.yaml. Install/link the ` +
          `contracts package or set ALCHEMIST_CONTRACTS_DIR to build from the real ` +
          `contract. The fixture is a stand-in for synth/tests only.`,
      );
    }

    const spec = parseSpec(resolved);
    injectCp1Authorizer(spec, props.tenantUserPool.userPool.userPoolArn);
    enableRequestValidation(spec);

    // Build the REST API FROM the (augmented) imported spec. `fromInline`
    // (rather than `fromAsset`) is required so the CP-1 user-pool ARN token is
    // resolved into the authorizer at synth time; no path/model/schema is
    // authored here — only the imported contract's controls are completed.
    this.restApi = new apigateway.SpecRestApi(this, 'Resource', {
      restApiName: props.restApiName ?? '1145-cp2-commands',
      apiDefinition: apigateway.ApiDefinition.fromInline(spec),
      deployOptions: { stageName: 'prod' },
    });

    this.restApiId = this.restApi.restApiId;
    this.rootResourceId = this.restApi.restApiRootResourceId;

    // Export id/root for command handlers (task 6.2) and other consumers.
    publishWiring(this, WiringKeys.restApiId, this.restApiId);
    publishWiring(this, WiringKeys.restApiRootResourceId, this.rootResourceId);
  }
}

/** Parse the resolved spec text (YAML or JSON) into a plain object. */
function parseSpec(resolved: ResolvedOpenApi): Record<string, any> {
  const loader: (input: string) => unknown =
    typeof (yaml as any).safeLoad === 'function'
      ? (yaml as any).safeLoad
      : (yaml as any).load;
  const doc = loader(resolved.raw);
  if (!doc || typeof doc !== 'object') {
    throw new Error(
      `CP-2 OpenAPI spec at ${resolved.path} did not parse to an object.`,
    );
  }
  return doc as Record<string, any>;
}

/**
 * Register a `cognito_user_pools` authorizer bound to the CP-1 pool and require
 * it on every method (root default + each operation). Handles both OpenAPI 3.x
 * (`components.securitySchemes`) and Swagger 2.0 (`securityDefinitions`).
 */
function injectCp1Authorizer(
  spec: Record<string, any>,
  userPoolArn: string,
): void {
  const scheme = {
    type: 'apiKey',
    name: 'Authorization',
    in: 'header',
    'x-amazon-apigateway-authtype': 'cognito_user_pools',
    'x-amazon-apigateway-authorizer': {
      type: 'cognito_user_pools',
      providerARNs: [userPoolArn],
    },
  };

  const isOpenApiV3 =
    typeof spec.openapi === 'string' && spec.openapi.startsWith('3');
  if (isOpenApiV3) {
    spec.components = spec.components ?? {};
    spec.components.securitySchemes = spec.components.securitySchemes ?? {};
    spec.components.securitySchemes[CP1_AUTHORIZER_SCHEME] = scheme;
  } else {
    spec.securityDefinitions = spec.securityDefinitions ?? {};
    spec.securityDefinitions[CP1_AUTHORIZER_SCHEME] = scheme;
  }

  const requirement = [{ [CP1_AUTHORIZER_SCHEME]: [] as string[] }];

  // Root-level default applies the CP-1 authorizer to every operation...
  spec.security = requirement;

  // ...and we also pin it on each operation so a per-operation override in the
  // imported contract can never leave a CP-2 method unauthenticated (R2.3).
  const paths = (spec.paths ?? {}) as Record<string, any>;
  for (const pathItem of Object.values(paths)) {
    if (!pathItem || typeof pathItem !== 'object') {
      continue;
    }
    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, any>)[method];
      if (op && typeof op === 'object') {
        op.security = requirement;
      }
    }
  }
}

/**
 * Enable spec-driven request validation globally: the validator checks both the
 * request body (against the contract's models) and request parameters, so a
 * non-conforming CP-2 request is rejected before reaching an integration (R2.6).
 */
function enableRequestValidation(spec: Record<string, any>): void {
  spec['x-amazon-apigateway-request-validators'] = {
    [CP2_REQUEST_VALIDATOR]: {
      validateRequestBody: true,
      validateRequestParameters: true,
    },
  };
  spec['x-amazon-apigateway-request-validator'] = CP2_REQUEST_VALIDATOR;
}
