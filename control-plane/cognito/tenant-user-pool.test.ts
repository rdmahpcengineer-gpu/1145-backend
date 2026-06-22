import { Stack, aws_apigateway as apigateway } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import {
  TenantUserPool,
  TENANT_ID_ATTRIBUTE,
  TENANT_ID_CLAIM,
} from './tenant-user-pool';
import { BackendApp } from '../../lib/backend-app';

/**
 * CDK synth / snapshot example tests for the CP-1 tenant/operator user pool
 * (task 5.1). Property tests are separate (task 5.3).
 *
 * Validates: Requirements 1.1, 1.2, 1.3
 */
describe('CP-1 TenantUserPool', () => {
  function synth() {
    const stack = new Stack();
    const construct = new TenantUserPool(stack, 'TenantUserPool');
    return { stack, construct, template: Template.fromStack(stack) };
  }

  it('provisions exactly one dedicated tenant/operator user pool (R1.1)', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: '1145-tenant-operator',
    });
  });

  it('declares the custom:tenantId attribute so tokens carry the tenant claim (R1.3)', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      Schema: Match.arrayWith([
        Match.objectLike({
          Name: TENANT_ID_ATTRIBUTE,
          AttributeDataType: 'String',
        }),
      ]),
    });
    // The claim surfaced in a verified token is namespaced `custom:`.
    expect(TENANT_ID_CLAIM).toBe('custom:tenantId');
  });

  it('exposes a dashboard client that can read the tenant claim (R1.3)', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ReadAttributes: Match.arrayWith([TENANT_ID_CLAIM]),
    });
  });

  it('does not let the client self-write the tenant claim (tenant is session-derived)', () => {
    const { template } = synth();
    const clients = template.findResources('AWS::Cognito::UserPoolClient');
    const writeAttrs =
      Object.values(clients)[0].Properties.WriteAttributes ?? [];
    expect(writeAttrs).not.toContain(TENANT_ID_CLAIM);
  });

  it('disables self sign-up (operators are provisioned with a tenant)', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
    });
  });

  it('exposes pool id/ARN as readonly members for CP-2/CP-3 consumers', () => {
    const { construct } = synth();
    expect(construct.userPoolId).toBeDefined();
    expect(construct.userPoolArn).toBeDefined();
    expect(construct.userPool).toBeDefined();
  });

  it('publishes pool id and ARN via shared wiring (SSM + output)', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/1145/aws-backend/control-plane/cognito-user-pool-id',
    });
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/1145/aws-backend/control-plane/cognito-user-pool-arn',
    });
  });

  it('builds a CP-2 Cognito authorizer bound to this pool', () => {
    const stack = new Stack();
    const pool = new TenantUserPool(stack, 'TenantUserPool');
    const api = new apigateway.RestApi(stack, 'Api');
    const authorizer = pool.createRestApiAuthorizer(stack, 'Cp2Authorizer');
    // Attach to a method so the authorizer materializes into the template.
    api.root.addMethod('GET', undefined, { authorizer });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::ApiGateway::Authorizer', {
      Type: 'COGNITO_USER_POOLS',
      Name: 'cp1-tenant-operator',
    });
  });

  it('is the only Cognito pool in the control plane — no investor pool merged (R1.2)', () => {
    const app = new BackendApp();
    const template = Template.fromStack(app.controlPlaneStack);
    // Exactly one pool: the tenant/operator pool. The investor-portal pool
    // lives in the frontend Amplify project and is never referenced here.
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: '1145-tenant-operator',
    });
  });
});
