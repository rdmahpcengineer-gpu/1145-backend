/**
 * ml/training — the ML-4 SageMaker train/eval/registry pipeline.
 *
 * Exposes both the technology-neutral train→eval→register flow + registry-entry
 * construction (testable without live SageMaker) and the CDK construct that
 * provisions the SageMaker pipeline and model registry.
 *
 * _Requirements: 23.1, 23.2, 23.3_
 */
export * from './types';
export * from './errors';
export * from './registry-entry';
export * from './pipeline';
export * from './sagemaker-pipeline-construct';
