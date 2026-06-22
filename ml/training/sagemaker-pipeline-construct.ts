/**
 * SageMakerTrainingPipeline — the ML-4 train/eval/registry pipeline construct.
 *
 * Provisions the SageMaker pipeline that trains, evaluates, and registers
 * models, plus the model registry the registered versions land in
 * (design.md "ML-4 — Model Pipeline"):
 *
 *  - a **model-package group** (`CfnModelPackageGroup`) — the model registry;
 *    each pipeline run registers a new version into this group, recording its
 *    evaluation metrics and a version-identifying entry (R23.2, R23.3);
 *  - a **SageMaker pipeline** (`CfnPipeline`) whose definition is the
 *    train → evaluate → register flow built by `buildPipelineDefinition`
 *    (R23.1);
 *  - a scoped **execution role** SageMaker assumes to run the pipeline and
 *    register model packages into the group.
 *
 * The flow logic and registry-entry shape live in `ml/training/pipeline.ts` and
 * `ml/training/registry-entry.ts`, so the train→eval→register behaviour is
 * testable without a live SageMaker pipeline. This construct only provisions
 * the infrastructure.
 *
 * Scoped to task 21.1 — added in its own module so it sits alongside the
 * concurrent ML-1 (Kinesis, 19.1) / ML-2 (Sentiment, 20.1) work without
 * touching it. The ML-5 Model Deployer (task 21.2) is intentionally NOT here.
 *
 * _Requirements: 23.1, 23.2, 23.3_
 */

import {
  Stack,
  aws_iam as iam,
  aws_sagemaker as sagemaker,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { buildPipelineDefinition } from './pipeline';

export interface SageMakerTrainingPipelineProps {
  /** Name of the model-package group (the registry). Defaults to a stable id. */
  readonly modelPackageGroupName?: string;
  /** Name of the SageMaker pipeline. Defaults to a stable id. */
  readonly pipelineName?: string;
  /**
   * ECR image URI used for the training/evaluation steps. A placeholder is used
   * when omitted so the pipeline can be synthesised before the training image
   * is published.
   */
  readonly trainingImageUri?: string;
  /** S3 URI of the training/evaluation input data. */
  readonly inputDataUri?: string;
  /** S3 URI prefix where model artifacts and evaluation reports are written. */
  readonly outputDataUri?: string;
}

export class SageMakerTrainingPipeline extends Construct {
  /** The model registry — registered model versions land here (R23.2/R23.3). */
  readonly modelRegistry: sagemaker.CfnModelPackageGroup;

  /** The SageMaker pipeline running the train → eval → register flow (R23.1). */
  readonly pipeline: sagemaker.CfnPipeline;

  /** The role SageMaker assumes to run the pipeline and register models. */
  readonly executionRole: iam.Role;

  /** Resolved model-package group name. */
  readonly modelPackageGroupName: string;

  /** Resolved pipeline name. */
  readonly pipelineName: string;

  constructor(
    scope: Construct,
    id: string,
    props: SageMakerTrainingPipelineProps = {},
  ) {
    super(scope, id);

    this.modelPackageGroupName =
      props.modelPackageGroupName ?? '1145-ai-model-registry';
    this.pipelineName = props.pipelineName ?? '1145-ai-train-eval-register';

    const trainingImageUri =
      props.trainingImageUri ?? 'placeholder.dkr.ecr.local/1145-training:latest';
    const inputDataUri = props.inputDataUri ?? 's3://1145-ai-ml/input/';
    const outputDataUri = props.outputDataUri ?? 's3://1145-ai-ml/models/';

    // --- Model registry (R23.2, R23.3) -----------------------------------
    //
    // The model-package group is the registry: each pipeline run registers a
    // new model package (version) into it, recording the evaluation metrics
    // and a version-identifying entry. Versioning is owned by SageMaker — every
    // registered package gets a monotonically increasing version in the group.
    this.modelRegistry = new sagemaker.CfnModelPackageGroup(
      this,
      'ModelRegistry',
      {
        modelPackageGroupName: this.modelPackageGroupName,
        modelPackageGroupDescription:
          'ML-4 model registry — evaluated, version-identified model packages',
      },
    );

    // --- Execution role ---------------------------------------------------
    //
    // SageMaker assumes this role to run the pipeline steps. It is scoped to:
    //  - training/processing job lifecycle,
    //  - registering model packages into the registry group above,
    //  - passing itself to the jobs it launches.
    this.executionRole = new iam.Role(this, 'PipelineExecutionRole', {
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
      description:
        'ML-4 SageMaker pipeline execution role (train/eval/register)',
    });

    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'TrainEvaluate',
        effect: iam.Effect.ALLOW,
        actions: [
          'sagemaker:CreateTrainingJob',
          'sagemaker:DescribeTrainingJob',
          'sagemaker:CreateProcessingJob',
          'sagemaker:DescribeProcessingJob',
          'sagemaker:CreateModel',
        ],
        resources: ['*'],
      }),
    );

    const region = Stack.of(this).region;
    const account = Stack.of(this).account;
    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RegisterModelPackage',
        effect: iam.Effect.ALLOW,
        actions: [
          'sagemaker:CreateModelPackage',
          'sagemaker:DescribeModelPackage',
          'sagemaker:ListModelPackages',
        ],
        resources: [
          `arn:aws:sagemaker:${region}:${account}:model-package-group/${this.modelPackageGroupName}`,
          `arn:aws:sagemaker:${region}:${account}:model-package/${this.modelPackageGroupName}/*`,
        ],
      }),
    );

    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PassSelfToJobs',
        effect: iam.Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [this.executionRole.roleArn],
        conditions: {
          StringEquals: { 'iam:PassedToService': 'sagemaker.amazonaws.com' },
        },
      }),
    );

    // --- Pipeline (R23.1) -------------------------------------------------
    //
    // The pipeline definition mirrors the technology-neutral train → evaluate
    // → register flow in `pipeline.ts`, so the construct and the testable flow
    // logic stay in agreement.
    const definition = buildPipelineDefinition({
      modelPackageGroupName: this.modelPackageGroupName,
      trainingImageUri,
      inputDataUri,
      outputDataUri,
      roleArn: this.executionRole.roleArn,
    });

    this.pipeline = new sagemaker.CfnPipeline(this, 'Pipeline', {
      pipelineName: this.pipelineName,
      pipelineDisplayName: this.pipelineName,
      pipelineDescription:
        'ML-4 train → evaluate → register pipeline (records metrics + version)',
      roleArn: this.executionRole.roleArn,
      pipelineDefinition: {
        PipelineDefinitionBody: JSON.stringify(definition),
      },
    });

    // The registry group must exist before the pipeline that registers into it.
    this.pipeline.node.addDependency(this.modelRegistry);
  }
}
