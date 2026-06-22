/**
 * ml/deploy/metric-comparator — the default "compare metrics" decision (ML-5).
 *
 * The deployer promotes a candidate model **iff** its evaluation metrics exceed
 * the deployed model's (Property 23, R24.1/R24.3). "Exceed" is made precise and
 * deterministic by comparing a single configured **objective metric** (e.g.
 * `accuracy`), with a direction:
 *
 *  - `higher-is-better` (default): candidate exceeds when its objective value is
 *    strictly greater than the deployed objective value.
 *  - `lower-is-better`: candidate exceeds when its objective value is strictly
 *    lower (for loss-style metrics).
 *
 * Strict comparison means a tie is `not-better` (retain the incumbent). When
 * either side lacks a finite value for the objective metric the result is
 * `incomparable`, which the deployer treats as a fail-safe retain.
 *
 * The notion of "exceeds" is intentionally a small, injectable
 * {@link MetricComparator} so the deployer's promotion logic can be tested with
 * any objective, and so an operator can swap the objective without touching the
 * deployer.
 *
 * _Requirements: 24.1, 24.3_
 */

import { EvalMetrics, MetricComparator, MetricComparison } from './types';

/** Default objective metric used when none is configured. */
export const DEFAULT_OBJECTIVE_METRIC = 'accuracy';

/** Whether a higher or lower objective value is "better". */
export type ObjectiveDirection = 'higher-is-better' | 'lower-is-better';

/** Options for {@link ObjectiveMetricComparator}. */
export interface ObjectiveMetricComparatorOptions {
  /** The objective metric name to compare on. Defaults to `accuracy`. */
  readonly metric?: string;
  /** Whether higher or lower is better. Defaults to `higher-is-better`. */
  readonly direction?: ObjectiveDirection;
}

/**
 * Compares candidate vs deployed metrics on a single configured objective.
 *
 * Returns `incomparable` (fail-safe retain) when either side is missing a
 * finite value for the objective metric; otherwise `better`/`not-better` based
 * on a strict comparison in the configured direction.
 */
export class ObjectiveMetricComparator implements MetricComparator {
  private readonly metric: string;
  private readonly direction: ObjectiveDirection;

  constructor(options: ObjectiveMetricComparatorOptions = {}) {
    this.metric = options.metric ?? DEFAULT_OBJECTIVE_METRIC;
    this.direction = options.direction ?? 'higher-is-better';
  }

  compare(candidate: EvalMetrics, deployed: EvalMetrics): MetricComparison {
    const candidateValue = finiteMetric(candidate, this.metric);
    const deployedValue = finiteMetric(deployed, this.metric);

    // Missing or non-finite objective on either side → not comparable.
    if (candidateValue === undefined || deployedValue === undefined) {
      return 'incomparable';
    }

    const exceeds =
      this.direction === 'higher-is-better'
        ? candidateValue > deployedValue
        : candidateValue < deployedValue;

    return exceeds ? 'better' : 'not-better';
  }
}

/**
 * Read a finite numeric metric value, or `undefined` when the metric is absent,
 * non-numeric, or non-finite (NaN/Infinity).
 */
function finiteMetric(
  metrics: EvalMetrics | undefined,
  name: string,
): number | undefined {
  if (!metrics || typeof metrics !== 'object') {
    return undefined;
  }
  const value = (metrics as Record<string, unknown>)[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}
