/**
 * ml/deploy — the ML-5 Model Deployer (design.md "ML-5 — Model Deployer").
 *
 * Exposes the technology-neutral promote/retain decision + collaborators
 * (testable without live SageMaker / AgentCore), the Lambda handler, and the
 * CDK construct that provisions the deployer Lambda + the AC_Runtime
 * active-model-version SSM parameter.
 *
 * _Requirements: 24.1, 24.2, 24.3_
 */
export * from './types';
export * from './metric-comparator';
export * from './approval-gate';
export * from './runtime-updater';
export * from './model-deployer';
export * from './handler';
export * from './model-deployer-construct';
