/**
 * ml/training/pipeline — the ML-4 train → evaluate → register flow.
 *
 * This is the technology-neutral orchestration that the SageMaker pipeline
 * mirrors (design.md "ML-4 — Model Pipeline"): a model is trained, then
 * evaluated to produce metrics, then registered — recording both the metrics
 * (R23.2) and a version-identifying registry entry (R23.3) in the model
 * registry.
 *
 * The individual steps (train, evaluate, version) are injected, so the flow can
 * be exercised end-to-end in tests without a live SageMaker training job. The
 * CDK construct (`sagemaker-pipeline-construct.ts`) provisions the real
 * SageMaker pipeline whose definition is produced by {@link buildPipelineDefinition}.
 *
 * _Requirements: 23.1, 23.2, 23.3_
 */

import { buildRegistryEntry } from './registry-entry';
import { EvalMetrics, ModelRegistry, RegistryEntry } from './types';

/**
 * The three steps of the pipeline, parameterised over the training input, the
 * trained-model artifact, and the evaluation input. Implementations call
 * SageMaker in production; tests pass pure functions.
 */
export interface TrainingPipelineSteps<TInput, TArtifact, TEvalInput> {
  /** Train a model from the training input (R23.1). */
  train(input: TInput): TArtifact | Promise<TArtifact>;
  /** Evaluate a trained model, producing metrics (R23.1, R23.2). */
  evaluate(
    model: TArtifact,
    evalInput: TEvalInput,
  ): EvalMetrics | Promise<EvalMetrics>;
  /** The version identifying the trained model (R23.3). */
  versionOf(model: TArtifact): string;
}

/** Input data for a single pipeline run. */
export interface RunPipelineInput<TInput, TEvalInput> {
  trainingInput: TInput;
  evalInput: TEvalInput;
}

/** Optional knobs for a pipeline run (injected clock for deterministic tests). */
export interface RunPipelineOptions {
  /** Source of the registration timestamp; defaults to `() => new Date()`. */
  clock?: () => Date;
}

/** The result of one pipeline run. */
export interface PipelineRunResult<TArtifact> {
  /** The trained model artifact. */
  model: TArtifact;
  /** The evaluation metrics recorded for the model (R23.2). */
  metrics: EvalMetrics;
  /** The registry entry recorded in the model registry (R23.3). */
  entry: RegistryEntry;
}

/**
 * Run the train → evaluate → register flow.
 *
 * 1. `train` produces a model artifact from the training input (R23.1).
 * 2. `evaluate` produces evaluation metrics for that artifact (R23.1).
 * 3. a version-identifying {@link RegistryEntry} carrying the metrics is built
 *    and recorded in the model registry (R23.2, R23.3).
 */
export async function runTrainingPipeline<TInput, TArtifact, TEvalInput>(
  steps: TrainingPipelineSteps<TInput, TArtifact, TEvalInput>,
  registry: ModelRegistry,
  input: RunPipelineInput<TInput, TEvalInput>,
  options: RunPipelineOptions = {},
): Promise<PipelineRunResult<TArtifact>> {
  const clock = options.clock ?? (() => new Date());

  // 1. Train.
  const model = await steps.train(input.trainingInput);

  // 2. Evaluate -> metrics.
  const metrics = await steps.evaluate(model, input.evalInput);

  // 3. Register: build a version-identifying entry carrying the metrics and
  //    record it in the model registry.
  const entry = buildRegistryEntry({
    modelVersion: steps.versionOf(model),
    metrics,
    registeredAt: clock(),
  });
  const stored = await registry.register(entry);

  return { model, metrics, entry: stored };
}

/**
 * A simple in-memory {@link ModelRegistry} that retains every recorded entry,
 * latest last. Used by tests and local runs to stand in for SageMaker's
 * model-package registry.
 */
export class InMemoryModelRegistry implements ModelRegistry {
  private readonly entries: RegistryEntry[] = [];

  register(entry: RegistryEntry): RegistryEntry {
    this.entries.push(entry);
    return entry;
  }

  /** All recorded entries in registration order. */
  list(): readonly RegistryEntry[] {
    return [...this.entries];
  }

  /** The most recently registered entry, or `undefined` if none. */
  latest(): RegistryEntry | undefined {
    return this.entries[this.entries.length - 1];
  }
}

/** Inputs that shape a SageMaker pipeline definition. */
export interface PipelineDefinitionInput {
  /** Name of the model-package group acting as the registry (R23.2/R23.3). */
  modelPackageGroupName: string;
  /** ECR image URI used for the training/evaluation steps. */
  trainingImageUri: string;
  /** S3 URI of the training/evaluation input data. */
  inputDataUri: string;
  /** S3 URI prefix where model artifacts are written. */
  outputDataUri: string;
  /** IAM role ARN the steps assume. */
  roleArn: string;
}

/**
 * Build the SageMaker pipeline definition body describing the train → evaluate
 * → register flow. Returned as a plain object so it can be asserted in tests
 * and serialised into the `CfnPipeline` definition.
 *
 * The definition has three ordered steps:
 *  - `Train`     — a training job that produces a model artifact (R23.1).
 *  - `Evaluate`  — a processing job that emits evaluation metrics (R23.1/R23.2).
 *  - `Register`  — registers the model into the model-package group, recording
 *                  the metrics and a version-identifying entry (R23.2/R23.3).
 */
export function buildPipelineDefinition(
  input: PipelineDefinitionInput,
): Record<string, unknown> {
  return {
    Version: '2020-12-01',
    Metadata: {},
    Parameters: [
      {
        Name: 'InputDataUri',
        Type: 'String',
        DefaultValue: input.inputDataUri,
      },
    ],
    Steps: [
      {
        Name: 'Train',
        Type: 'Training',
        Arguments: {
          AlgorithmSpecification: {
            TrainingImage: input.trainingImageUri,
            TrainingInputMode: 'File',
          },
          RoleArn: input.roleArn,
          InputDataConfig: [
            {
              ChannelName: 'training',
              DataSource: {
                S3DataSource: { S3Uri: input.inputDataUri },
              },
            },
          ],
          OutputDataConfig: { S3OutputPath: input.outputDataUri },
        },
      },
      {
        Name: 'Evaluate',
        Type: 'Processing',
        DependsOn: ['Train'],
        Arguments: {
          AppSpecification: { ImageUri: input.trainingImageUri },
          RoleArn: input.roleArn,
        },
      },
      {
        Name: 'Register',
        Type: 'RegisterModel',
        DependsOn: ['Evaluate'],
        Arguments: {
          ModelPackageGroupName: input.modelPackageGroupName,
          // The evaluation metrics recorded with the registered version.
          ModelMetrics: {
            ModelQuality: {
              Statistics: {
                ContentType: 'application/json',
                S3Uri: `${input.outputDataUri}/evaluation.json`,
              },
            },
          },
        },
      },
    ],
  };
}
