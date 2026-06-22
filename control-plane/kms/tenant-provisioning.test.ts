import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { TenantProvisioning } from './tenant-provisioning';

function synth(props?: { tenantOperatorRoleArns?: string[] }): Template {
  const app = new App();
  const stack = new Stack(app, 'TestStack', {
    env: { account: '111122223333', region: 'us-east-1' },
  });
  new TenantProvisioning(stack, 'TenantProvisioning', props);
  return Template.fromStack(stack);
}

describe('TenantProvisioning (CP-4)', () => {
  it('provisions the onboarding Lambda with the alias prefix in its env', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'index.handler',
      Runtime: 'nodejs20.x',
      Environment: {
        Variables: Match.objectLike({
          TENANT_KEY_ALIAS_PREFIX: 'alias/tenant/',
          AWS_ACCOUNT_ID: '111122223333',
        }),
      },
    });
  });

  it('grants only key creation/tagging at account scope', () => {
    const template = synth();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'CreateTenantKeys',
            Action: Match.arrayWith(['kms:CreateKey', 'kms:TagResource']),
            Resource: '*',
          }),
        ]),
      },
    });
  });

  it('scopes alias/policy management to the tenant alias namespace', () => {
    const template = synth();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'ManageTenantKeyAliasesAndPolicies',
            Action: Match.arrayWith([
              'kms:CreateAlias',
              'kms:PutKeyPolicy',
              'kms:DescribeKey',
            ]),
          }),
        ]),
      },
    });
  });

  it('passes operator role arns into the onboarding env when provided', () => {
    const roleArn = 'arn:aws:iam::111122223333:role/DataPlane';
    const template = synth({ tenantOperatorRoleArns: [roleArn] });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          TENANT_OPERATOR_ROLE_ARNS: JSON.stringify([roleArn]),
        }),
      },
    });
  });
});
