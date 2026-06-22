import {
  InMemoryModelRegistry,
  TrainingPipelineSteps,
  buildPipelineDefinition,
  runTrainingPipeline,
} from './pipeline';
import { EvalMetrics } from './types';

/**
 * ML-4 train → evaluate → register flow (task 21.1 / Req 23.1, 23.2, 23.3).
 *
 * Exercised with injected steps and an in-memory registry, so the flow is
 * verified end-to-end without a live SageMaker pipeline.
 */
describe('training/pipeline — runTrainingPipeline (R23.1, R23.2, R23.3)', () => {
  // A trivial trained-model artifact carrying its own version + metrics.
  interface FakeModel {
    version: string;
    metrics: EvalMetrics;
  }

  const steps: TrainingPipelineSteps<number[], FakeModel, number[]> = {
    train: (data) => ({
      version: `v-${data.length}`,
      metrics: { accuracy: 0 },
    }),
    evaluate: (_model, evalData) => ({
      accuracy: evalData.length === 0 ? 0 : 1 / evalData.length,
      samples: evalData.length,
    }),
    versionOf: (model) => model.version,
  };

  it('trains, evaluates, then registers a version-identifying entry with metrics', async () => {
    const registry = new InMemoryModelRegistry();
    const result = await runTrainingPipeline(
      steps,
      registry,
      { trainingInput: [1, 2, 3], evalInput: [9, 8] },
      { clock: () => new Date('2024-01-01T00:00:00.000Z') },
    );

    // Version identified from the trained model (R23.3).
    expect(result.entry.modelVersion).toBe('v-3');
    // Evaluation metrics recorded with the entry (R23.2).
    expect(result.entry.metrics).toEqual({ accuracy: 0.5, samples: 2 });
    expect(result.entry.registeredAt).toBe('2024-01-01T00:00:00.000Z');
    expect(result.metrics).toEqual({ accuracy: 0.5, samples: 2 });
  });

  it('records the entry in the model registry', async () => {
    const registry = new InMemoryModelRegistry();
    await runTrainingPipeline(steps, registry, {
      trainingInput: [1, 2],
      evalInput: [1, 2, 3, 4],
    });

    expect(registry.list()).toHaveLength(1);
    expect(registry.latest()?.modelVersion).toBe('v-2');
    expect(registry.latest()?.metrics.samples).toBe(4);
  });

  it('supports async steps (mirrors real SageMaker calls)', async () => {
    const asyncSteps: TrainingPipelineSteps<string, FakeModel, string> = {
      train: async (id) => ({ version: id, metrics: { accuracy: 0 } }),
      evaluate: async () => ({ accuracy: 0.99 }),
      versionOf: (m) => m.version,
    };
    const registry = new InMemoryModelRegistry();
    const result = await runTrainingPipeline(asyncSteps, registry, {
      trainingInput: 'model-async',
      evalInput: 'holdout',
    });
    expect(result.entry.modelVersion).toBe('model-async');
    expect(result.entry.metrics.accuracy).toBe(0.99);
  });
});

describe('training/pipeline — buildPipelineDefinition (R23.1, R23.2, R23.3)', () => {
  const def = buildPipelineDefinition({
    modelPackageGroupName: 'registry-group',
    trainingImageUri: 'img:latest',
    inputDataUri: 's3://bucket/in/',
    outputDataUri: 's3://bucket/out/',
    roleArn: 'arn:aws:iam::111122223333:role/exec',
  });

  function stepNames(d: Record<string, unknown>): string[] {
    const steps = d.Steps as Array<{ Name: string }>;
    return steps.map((s) => s.Name);
  }

  it('describes an ordered train → evaluate → register flow', () => {
    expect(stepNames(def)).toEqual(['Train', 'Evaluate', 'Register']);
  });

  it('registers into the model-package group (the registry)', () => {
    const steps = def.Steps as Array<{
      Name: string;
      Type: string;
      Arguments: Record<string, unknown>;
    }>;
    const register = steps.find((s) => s.Name === 'Register')!;
    expect(register.Type).toBe('RegisterModel');
    expect(register.Arguments.ModelPackageGroupName).toBe('registry-group');
    // Evaluation metrics are recorded with the registered version (R23.2).
    expect(register.Arguments.ModelMetrics).toBeDefined();
  });

  it('serialises to a JSON string for the CfnPipeline definition body', () => {
    expect(() => JSON.stringify(def)).not.toThrow();
    expect(JSON.stringify(def)).toContain('RegisterModel');
  });
});
