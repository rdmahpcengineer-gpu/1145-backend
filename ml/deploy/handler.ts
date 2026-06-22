/**
 * ml/deploy/handler — the ML-5 Model Deployer Lambda entrypoint.
 *
 * Triggered when the ML-4 pipeline registers a new model version. The handler
 * adapts the registration event to the pure {@link ModelDeployer} logic and
 * provides a real {@link SsmParameterRuntimeUpdater} so a promote updates the
 * AC_Runtime's active model version (R24.2). The A2 approval gate defaults to
 * auto-promote and is switched to a manual hold via the
 * {@link REQUIRE_APPROVAL_ENV} environment flag — so an operator can require
 * sign-off without a code change.
 *
 * The event shape is modeled behind a minimal {@link DeployEvent} interface
 * rather than depending on the ML-4 pipeline's exact export, keeping the two
 * tasks decoupled. The pure decision lives in `model-deployer.ts` and is tested
 * against in-memory fakes; this entrypoint is intentionally thin.
 *
 * _Requirements: 24.1, 24.2, 24.3_
 */

import { approvalGateFromFlag } from './approval-gate';
import { ModelDeployer } from './model-deployer';
import {
  ACTIVE_MODEL_VERSION_PARAM,
  SsmParameterRuntimeUpdater,
} from './runtime-updater';
import { CandidateModel, DeploymentOutcome, ModelMetricsSnapshot } from './types';

/** Env flag: when `"true"`, require manual approval (hold) before promoting. */
export const REQUIRE_APPROVAL_ENV = 'ML5_REQUIRE_APPROVAL';

/** Env var carrying the SSM parameter name the AC_Runtime reads. */
export const ACTIVE_MODEL_VERSION_PARAM_ENV = 'ML5_ACTIVE_MODEL_VERSION_PARAM';

/** The registration event the deployer reacts to. */
export interface DeployEvent {
  /** The newly registered candidate model and its evaluation metrics. */
  readonly candidate: ModelMetricsSnapshot;
  /** The currently deployed model and its metrics, if any. */
  readonly deployed?: ModelMetricsSnapshot;
}

/** Whether manual approval is required, from the env flag. */
function requireApproval(): boolean {
  return (process.env[REQUIRE_APPROVAL_ENV] ?? '').toLowerCase() === 'true';
}

/** The SSM parameter name the runtime updater writes (env override allowed). */
function activeModelVersionParam(): string {
  return process.env[ACTIVE_MODEL_VERSION_PARAM_ENV] ?? ACTIVE_MODEL_VERSION_PARAM;
}

/**
 * The Lambda handler. Builds the deployer with the SSM-backed runtime updater
 * and the env-configured approval gate, then runs the promote/retain decision
 * for the registered candidate against the currently deployed model.
 */
export async function handler(event: DeployEvent): Promise<DeploymentOutcome> {
  const deployer = new ModelDeployer({
    runtimeUpdater: new SsmParameterRuntimeUpdater({
      parameterName: activeModelVersionParam(),
    }),
    approvalGate: approvalGateFromFlag(requireApproval()),
  });

  const candidate: CandidateModel = event.candidate;
  return deployer.deploy(candidate, event.deployed);
}
