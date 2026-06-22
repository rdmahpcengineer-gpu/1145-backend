/**
 * ml/deploy/types — shared shapes for the ML-5 Model Deployer.
 *
 * The deployer compares a registered (candidate) model's evaluation metrics to
 * the currently deployed model's metrics and promotes the candidate **iff** its
 * metrics exceed the deployed model's (design.md "ML-5 — Model Deployer",
 * Property 23, Requirements 24.1/24.2/24.3). On a promote it updates the
 * AC_Runtime to use the promoted model version; otherwise it retains the
 * currently deployed model. Missing/incomparable metrics fail safe to the
 * status quo (retain).
 *
 * Every decision and side effect is modeled behind a small injectable
 * interface so the promotion logic is unit-testable without live SageMaker /
 * AgentCore:
 *  - {@link MetricComparator} — the "compare metrics" decision.
 *  - {@link ApprovalGate}     — the configurable A2 approval-gate hook.
 *  - {@link RuntimeModelUpdater} — the "apply promotion" side effect.
 *
 * `EvalMetrics`/`RegistryEntry` are reused from the ML-4 `ml/training` module
 * rather than redefined, so the two stages agree on the metric/entry shape.
 *
 * _Requirements: 24.1, 24.2, 24.3_
 */

import { EvalMetrics, RegistryEntry } from '../training/types';

export { EvalMetrics, RegistryEntry } from '../training/types';

/**
 * A model under consideration for promotion or already deployed: the minimal
 * shape the deployer reasons over — a version identifier and its evaluation
 * metrics. A full ML-4 {@link RegistryEntry} is assignable to this.
 */
export interface ModelMetricsSnapshot {
  /** The model version this snapshot identifies. */
  readonly modelVersion: string;
  /** The evaluation metrics recorded for this version (R23.2). */
  readonly metrics: EvalMetrics;
}

/** A {@link RegistryEntry} satisfies {@link ModelMetricsSnapshot}. */
export type CandidateModel = ModelMetricsSnapshot | RegistryEntry;

/** The currently deployed model, or `undefined` when nothing is deployed yet. */
export type DeployedModel = ModelMetricsSnapshot | undefined;

/**
 * The outcome of comparing candidate metrics to deployed metrics.
 *  - `better`       — candidate metrics exceed the deployed metrics (promote).
 *  - `not-better`   — metrics are comparable but the candidate does not exceed.
 *  - `incomparable` — metrics are missing/not comparable (fail safe to retain).
 */
export type MetricComparison = 'better' | 'not-better' | 'incomparable';

/**
 * Compares a candidate model's metrics to the deployed model's metrics. This is
 * the injectable "compare metrics" decision; the default objective comparator
 * lives in `metric-comparator.ts`.
 */
export interface MetricComparator {
  compare(candidate: EvalMetrics, deployed: EvalMetrics): MetricComparison;
}

/** A request placed before the A2 approval-gate hook ahead of a runtime update. */
export interface ApprovalRequest {
  /** The candidate version that the metric comparison decided to promote. */
  readonly candidateVersion: string;
  /** The currently deployed version, if any. */
  readonly deployedVersion?: string;
  /** The candidate's evaluation metrics. */
  readonly candidateMetrics: EvalMetrics;
  /** The deployed model's evaluation metrics, if any. */
  readonly deployedMetrics?: EvalMetrics;
}

/**
 * The configurable approval-gate hook (assumption A2). Inserted **before** the
 * runtime update so an operator can require manual sign-off without code
 * changes. The default gate (`AutoApproveGate`) is disabled/auto-promote.
 *
 * Returning `false` defers an otherwise-Promote decision: the deployer retains
 * the currently deployed model until approval is granted.
 */
export interface ApprovalGate {
  approve(request: ApprovalRequest): boolean | Promise<boolean>;
}

/**
 * Applies a promotion by updating the AC_Runtime to use the promoted model
 * version (R24.2). This is the injectable "apply promotion" side effect — in
 * production it writes the active model version where the AgentCore runtime
 * (`Session.model_version`) reads it; tests pass an in-memory fake.
 */
export interface RuntimeModelUpdater {
  updateModelVersion(modelVersion: string): void | Promise<void>;
}

/** Why the deployer retained the currently deployed model. */
export type RetainReason =
  /** Metrics comparable, but the candidate did not exceed the deployed model. */
  | 'not-better'
  /** Metrics missing/not comparable — fail safe to the status quo. */
  | 'incomparable'
  /** Metrics exceeded, but the approval-gate hook withheld sign-off. */
  | 'approval-withheld';

/**
 * The pure metric decision (no approval gate, no side effects): Promote iff the
 * candidate metrics exceed the deployed metrics, else Retain (Property 23).
 */
export type PromotionDecision =
  | { readonly kind: 'promote'; readonly modelVersion: string }
  | { readonly kind: 'retain'; readonly reason: RetainReason };

/**
 * The result of a full {@link RuntimeModelUpdater}-applied deployment.
 *  - `promoted` — the candidate was promoted and the runtime updated (R24.1/24.2).
 *  - `retained` — the currently deployed model was kept (R24.3).
 */
export type DeploymentOutcome =
  | {
      readonly status: 'promoted';
      readonly modelVersion: string;
      readonly previousVersion?: string;
    }
  | {
      readonly status: 'retained';
      readonly deployedVersion?: string;
      readonly reason: RetainReason;
    };
