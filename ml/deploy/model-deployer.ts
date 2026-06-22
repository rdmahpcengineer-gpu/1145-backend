/**
 * ml/deploy/model-deployer — the ML-5 Model Deployer (design.md "ML-5").
 *
 * Compares a registered (candidate) model's evaluation metrics to the currently
 * deployed model's metrics and decides whether to promote:
 *
 *   Promote  ⇔  candidate metrics exceed deployed metrics      (Property 23)
 *
 * On a promote it updates the AC_Runtime to use the promoted model version
 * (R24.2); otherwise it retains the currently deployed model (R24.3). Missing or
 * incomparable metrics fail safe to the status quo (retain).
 *
 * The deployer composes three injectable collaborators so its logic is fully
 * unit-testable without live SageMaker / AgentCore:
 *  - a {@link MetricComparator} — the "compare metrics" decision (default:
 *    {@link ObjectiveMetricComparator});
 *  - an {@link ApprovalGate}    — the configurable A2 approval-gate hook,
 *    consulted **before** the runtime update (default: {@link AutoApproveGate},
 *    i.e. auto-promote);
 *  - a {@link RuntimeModelUpdater} — the "apply promotion" side effect.
 *
 * Two entry points keep the pure decision separate from the side effect:
 *  - {@link evaluate} — the pure metric decision (Promote iff metrics exceed),
 *    with no approval gate and no side effects. This is the IFF of Property 23.
 *  - {@link deploy}   — runs the decision, consults the approval gate, and on
 *    approval applies the runtime update; returns the deployment outcome.
 *
 * _Requirements: 24.1, 24.2, 24.3_
 */

import { AutoApproveGate } from './approval-gate';
import { ObjectiveMetricComparator } from './metric-comparator';
import {
  ApprovalGate,
  CandidateModel,
  DeployedModel,
  DeploymentOutcome,
  MetricComparator,
  PromotionDecision,
  RuntimeModelUpdater,
} from './types';

/** Construction options for {@link ModelDeployer}. */
export interface ModelDeployerOptions {
  /** Applies the promotion by updating the AC_Runtime model version (R24.2). */
  readonly runtimeUpdater: RuntimeModelUpdater;
  /**
   * The "compare metrics" decision. Defaults to an
   * {@link ObjectiveMetricComparator} (higher `accuracy` is better).
   */
  readonly comparator?: MetricComparator;
  /**
   * The configurable A2 approval-gate hook, consulted before the runtime
   * update. Defaults to {@link AutoApproveGate} (disabled/auto-promote).
   */
  readonly approvalGate?: ApprovalGate;
}

export class ModelDeployer {
  private readonly runtimeUpdater: RuntimeModelUpdater;
  private readonly comparator: MetricComparator;
  private readonly approvalGate: ApprovalGate;

  constructor(options: ModelDeployerOptions) {
    this.runtimeUpdater = options.runtimeUpdater;
    this.comparator = options.comparator ?? new ObjectiveMetricComparator();
    this.approvalGate = options.approvalGate ?? new AutoApproveGate();
  }

  /**
   * The pure promotion decision: Promote **iff** the candidate metrics exceed
   * the deployed metrics; otherwise Retain (Property 23, R24.1/R24.3). No
   * approval gate is applied and no side effect occurs.
   *
   * - No deployed model yet → the candidate is, by definition, an improvement
   *   over "nothing deployed" and is promoted.
   * - Missing/incomparable metrics → Retain with reason `incomparable`
   *   (fail safe to the status quo).
   */
  evaluate(candidate: CandidateModel, deployed: DeployedModel): PromotionDecision {
    // Nothing deployed: promote the first viable candidate.
    if (deployed === undefined) {
      return { kind: 'promote', modelVersion: candidate.modelVersion };
    }

    const comparison = this.comparator.compare(
      candidate.metrics,
      deployed.metrics,
    );

    if (comparison === 'better') {
      return { kind: 'promote', modelVersion: candidate.modelVersion };
    }
    if (comparison === 'incomparable') {
      return { kind: 'retain', reason: 'incomparable' };
    }
    return { kind: 'retain', reason: 'not-better' };
  }

  /**
   * Run the full deployment: evaluate the metric decision, consult the approval
   * gate before any runtime update (A2), and on approval update the AC_Runtime
   * to the promoted version (R24.2). Returns the deployment outcome; on any
   * retain path the currently deployed model is kept (R24.3).
   */
  async deploy(
    candidate: CandidateModel,
    deployed: DeployedModel,
  ): Promise<DeploymentOutcome> {
    const decision = this.evaluate(candidate, deployed);

    if (decision.kind === 'retain') {
      return {
        status: 'retained',
        deployedVersion: deployed?.modelVersion,
        reason: decision.reason,
      };
    }

    // Metrics exceed → would promote. Gate the runtime update on approval (A2).
    const approved = await this.approvalGate.approve({
      candidateVersion: candidate.modelVersion,
      deployedVersion: deployed?.modelVersion,
      candidateMetrics: candidate.metrics,
      deployedMetrics: deployed?.metrics,
    });

    if (!approved) {
      // Approval withheld: retain the incumbent until sign-off (no update).
      return {
        status: 'retained',
        deployedVersion: deployed?.modelVersion,
        reason: 'approval-withheld',
      };
    }

    // Apply the promotion: update the AC_Runtime to the promoted version.
    await this.runtimeUpdater.updateModelVersion(decision.modelVersion);

    return {
      status: 'promoted',
      modelVersion: decision.modelVersion,
      previousVersion: deployed?.modelVersion,
    };
  }
}
