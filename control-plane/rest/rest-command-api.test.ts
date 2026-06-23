import { App, Stack } from 'aws-cdk-lib';
import { Capture, Match, Template } from 'aws-cdk-lib/assertions';
import { TenantUserPool } from '../cognito/tenant-user-pool';
import {
  CP1_AUTHORIZER_SCHEME,
  CP2_REQUEST_VALIDATOR,
  RestCommandApi,
} from './rest-command-api';
import { FIXTURE_OPENAPI_PATH, resolveOpenApiSpec } from './openapi-source';

/**
 * CP-2 REST command API synth assertions (task 6.1 / Req 2.1, 2.2, 2.3, 2.6).
 *
 * These build the construct against the LOCAL FIXTURE (the @alchemist/contracts
 * package is not present in this workspace) and assert the SpecRestApi is built
 * FROM the spec with the CP-1 Cognito authorizer on every method and spec-driven
 * request validation enabled — without any locally-authored paths/models.
 */
describe('RestCommandApi — CP-2 SpecRestApi from imported openapi.yaml', () => {
  function build(): { template: Template; api: RestCommandApi } {
    const app = new App();
    const stack = new Stack(app, 'TestControlPlane', {
      env: { account: '111122223333', region: 'us-east-1' },
    });
    const pool = new TenantUserPool(stack, 'TenantUserPool');
    const api = new RestCommandApi(stack, 'RestCommandApi', {
      tenantUserPool: pool,
      // Be explicit: this workspace has no contracts package, so we synth from
      // the bundled stand-in fixture.
      allowFixtureFallback: true,
    });
    return { template: Template.fromStack(stack), api };
  }

  it('provisions exactly one API Gateway REST API as a SpecRestApi (inline body)', () => {
    const { template } = build();
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    // SpecRestApi carries the OpenAPI document inline under `Body`.
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Body: Match.objectLike({ openapi: Match.stringLikeRegexp('^3\\.') }),
    });
  });

  it('injects the CP-1 Cognito authorizer as a security scheme bound to the CP-1 pool', () => {
    const { template } = build();
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Body: Match.objectLike({
        components: Match.objectLike({
          securitySchemes: Match.objectLike({
            [CP1_AUTHORIZER_SCHEME]: Match.objectLike({
              type: 'apiKey',
              name: 'Authorization',
              in: 'header',
              'x-amazon-apigateway-authtype': 'cognito_user_pools',
              'x-amazon-apigateway-authorizer': Match.objectLike({
                type: 'cognito_user_pools',
                // Bound to the CP-1 user pool ARN (a resolved token).
                providerARNs: Match.anyValue(),
              }),
            }),
          }),
        }),
      }),
    });
  });

  it('requires the CP-1 authorizer on every method (root default + each operation)', () => {
    const { template } = build();
    const body = new Capture();
    template.hasResourceProperties('AWS::ApiGateway::RestApi', { Body: body });
    const doc = body.asObject() as any;

    // Root-level default requirement.
    expect(doc.security).toEqual([{ [CP1_AUTHORIZER_SCHEME]: [] }]);

    // Every operation under every path carries the same requirement.
    const httpMethods = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'];
    const operations: any[] = [];
    for (const pathItem of Object.values<any>(doc.paths)) {
      for (const method of httpMethods) {
        if (pathItem[method]) {
          operations.push(pathItem[method]);
        }
      }
    }
    expect(operations.length).toBeGreaterThan(0);
    for (const op of operations) {
      expect(op.security).toEqual([{ [CP1_AUTHORIZER_SCHEME]: [] }]);
    }
  });

  it('enables spec-driven request validation (body + parameters) globally', () => {
    const { template } = build();
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Body: Match.objectLike({
        'x-amazon-apigateway-request-validator': CP2_REQUEST_VALIDATOR,
        'x-amazon-apigateway-request-validators': Match.objectLike({
          [CP2_REQUEST_VALIDATOR]: {
            validateRequestBody: true,
            validateRequestParameters: true,
          },
        }),
      }),
    });
  });

  it('does not author paths/models locally — they come from the imported spec', () => {
    const { template } = build();
    const body = new Capture();
    template.hasResourceProperties('AWS::ApiGateway::RestApi', { Body: body });
    const doc = body.asObject() as any;
    // The path + model originate from the spec file, not from CDK `addResource`
    // / `addModel` calls (which would emit AWS::ApiGateway::Resource / ::Model).
    template.resourceCountIs('AWS::ApiGateway::Resource', 0);
    template.resourceCountIs('AWS::ApiGateway::Model', 0);
    // Paths + schemas originate from the imported @alchemist/contracts spec.
    expect(Object.keys(doc.paths)).toContain('/appointments');
    expect(doc.components.schemas.BookAppointmentRequest).toBeDefined();
  });

  it('exports the REST API id and root resource id via shared wiring', () => {
    const { template } = build();
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/1145/aws-backend/control-plane/rest-api-id',
    });
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/1145/aws-backend/control-plane/rest-api-root-resource-id',
    });
  });

  it('reports the imported-contract origin when @alchemist/contracts is installed', () => {
    const { api } = build();
    expect(api.specOrigin).toBe('imported-contract');
  });
});

/**
 * Spec-source resolution: imported-contract first, then injected path, then the
 * local stand-in fixture so synth/tests run without @alchemist/contracts.
 */
describe('resolveOpenApiSpec — synth-resilient contract resolution', () => {
  const ORIGINAL_ENV = process.env.ALCHEMIST_CONTRACTS_DIR;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.ALCHEMIST_CONTRACTS_DIR;
    } else {
      process.env.ALCHEMIST_CONTRACTS_DIR = ORIGINAL_ENV;
    }
  });

  it('resolves the imported @alchemist/contracts spec by default', () => {
    delete process.env.ALCHEMIST_CONTRACTS_DIR;
    const resolved = resolveOpenApiSpec();
    expect(resolved.origin).toBe('imported-contract');
    expect(resolved.path).toMatch(
      /@alchemist[/\\]contracts[/\\]openapi[/\\]openapi\.yaml$/,
    );
    expect(resolved.raw).toContain('openapi:');
  });

  it('falls back to the bundled fixture when the contract is unresolvable', () => {
    // Point resolution at a real directory that does NOT contain the artifact,
    // forcing a MissingContractArtifactError -> the local fixture stand-in.
    process.env.ALCHEMIST_CONTRACTS_DIR = __dirname;
    const resolved = resolveOpenApiSpec();
    expect(resolved.origin).toBe('test-fixture');
    expect(resolved.path).toBe(FIXTURE_OPENAPI_PATH);
    expect(resolved.raw).toContain('openapi:');
  });

  it('uses an explicitly injected spec path with highest priority', () => {
    const resolved = resolveOpenApiSpec({ specPath: FIXTURE_OPENAPI_PATH });
    expect(resolved.origin).toBe('injected-path');
    expect(resolved.path).toBe(FIXTURE_OPENAPI_PATH);
  });

  it('fails loudly when the contract is unresolvable and fallback is disabled', () => {
    process.env.ALCHEMIST_CONTRACTS_DIR = __dirname;
    expect(() =>
      resolveOpenApiSpec({ allowFixtureFallback: false }),
    ).toThrow();
  });
});
