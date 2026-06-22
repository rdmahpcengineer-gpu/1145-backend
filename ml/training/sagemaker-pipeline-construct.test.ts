import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { SageMakerTrainingPipeline } from './sagemaker-pipeline-construct';

/**
 * ML-4 SageMaker pipeline synth assertions (task 21.1 / Req 23.1, 23.2, 23.3).
 *
 * Confirms the construct provisions the model registry (a model-package group),
 * the SageMaker pipeline running the train→eval→register flow, and a scoped
 * execution role.
 */
describe('SageMakerTrainingPipeline — synth (R23.1, R23.2, R23.3)', () => {
  function template(): Template {
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '111122223333', region: 'us-east-1' },
    });
    new SageMakerTrainingPipeline(stack, 'TrainingPipeline');
    return Template.fromStack(stack);
  }

  it('provisions a model-package group as the model registry (R23.2/R23.3)', () => {
    const t = template();
    t.resourceCountIs('AWS::SageMaker::ModelPackageGroup', 1);
    t.hasResourceProperties('AWS::SageMaker::ModelPackageGroup', {
      ModelPackageGroupName: '1145-ai-model-registry',
    });
  });

  it('provisions a SageMaker pipeline with a train→eval→register definition (R23.1)', () => {
    const t = template();
    t.resourceCountIs('AWS::SageMaker::Pipeline', 1);
    // The definition body embeds the role ARN token, so CloudFormation renders
    // it as an Fn::Join whose static fragments still carry the flow's step
    // types (the literal JSON content is asserted in pipeline.test.ts).
    t.hasResourceProperties('AWS::SageMaker::Pipeline', {
      PipelineName: '1145-ai-train-eval-register',
      PipelineDefinition: {
        PipelineDefinitionBody: {
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([Match.stringLikeRegexp('RegisterModel')]),
          ]),
        },
      },
    });
  });

  it('provisions an execution role assumed by SageMaker that can register models', () => {
    const t = template();
    t.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'sagemaker.amazonaws.com' },
          }),
        ]),
      },
    });
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'RegisterModelPackage',
            Action: Match.arrayWith(['sagemaker:CreateModelPackage']),
          }),
        ]),
      },
    });
  });

  it('honours overridden names', () => {
    const app = new App();
    const stack = new Stack(app, 'OverrideStack', {
      env: { account: '111122223333', region: 'us-east-1' },
    });
    new SageMakerTrainingPipeline(stack, 'Custom', {
      modelPackageGroupName: 'custom-registry',
      pipelineName: 'custom-pipeline',
    });
    const t = Template.fromStack(stack);
    t.hasResourceProperties('AWS::SageMaker::ModelPackageGroup', {
      ModelPackageGroupName: 'custom-registry',
    });
    t.hasResourceProperties('AWS::SageMaker::Pipeline', {
      PipelineName: 'custom-pipeline',
    });
  });
});
