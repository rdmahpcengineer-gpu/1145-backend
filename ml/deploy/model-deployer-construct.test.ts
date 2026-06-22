import { Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ModelDeployerConstruct } from './model-deployer-construct';
import { ACTIVE_MODEL_VERSION_PARAM } from './runtime-updater';
import {
  ACTIVE_MODEL_VERSION_PARAM_ENV,
  REQUIRE_APPROVAL_ENV,
} from './handler';

/**
 * Synth/snapshot tests for the ML-5 Model Deployer construct (task 21.2).
 * Exercised in an isolated test stack so it does not couple to the concurrent
 * ML-1/ML-2/ML-4 work in MlStack.
 */
function synth(build: (stack: Stack) => void): Template {
  const stack = new Stack(undefined, 'TestStack', {
    env: { account: '111122223333', region: 'us-east-1' },
  });
  build(stack);
  return Template.fromStack(stack);
}

describe('ModelDeployerConstruct (ML-5, Req 24.1, 24.2, 24.3)', () => {
  it('provisions the deployer Lambda and the active-model-version parameter', () => {
    const t = synth((s) => {
      new ModelDeployerConstruct(s, 'ModelDeployer');
    });
    t.resourceCountIs('AWS::Lambda::Function', 1);
    t.resourceCountIs('AWS::SSM::Parameter', 1);
    t.hasResourceProperties('AWS::SSM::Parameter', {
      Name: ACTIVE_MODEL_VERSION_PARAM,
      Type: 'String',
    });
  });

  it('defaults the A2 approval hook to auto-promote (requireApproval=false)', () => {
    const t = synth((s) => {
      new ModelDeployerConstruct(s, 'ModelDeployer');
    });
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          [REQUIRE_APPROVAL_ENV]: 'false',
          [ACTIVE_MODEL_VERSION_PARAM_ENV]: ACTIVE_MODEL_VERSION_PARAM,
        }),
      },
    });
  });

  it('can require manual approval without a code change', () => {
    const t = synth((s) => {
      new ModelDeployerConstruct(s, 'ModelDeployer', { requireApproval: true });
    });
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ [REQUIRE_APPROVAL_ENV]: 'true' }),
      },
    });
  });

  it('grants the deployer least-privilege PutParameter on the active-version parameter', () => {
    const t = synth((s) => {
      new ModelDeployerConstruct(s, 'ModelDeployer');
    });
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'ssm:PutParameter',
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  it('exposes the construct members for cross-stack wiring', () => {
    const stack = new Stack(undefined, 'MemberStack', {
      env: { account: '111122223333', region: 'us-east-1' },
    });
    const deployer = new ModelDeployerConstruct(stack, 'ModelDeployer');
    expect(deployer.function).toBeDefined();
    expect(deployer.activeModelVersionParameter).toBeDefined();
    expect(deployer.activeModelVersionParamName).toBe(ACTIVE_MODEL_VERSION_PARAM);
  });
});
