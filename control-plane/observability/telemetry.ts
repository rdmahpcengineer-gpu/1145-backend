import {
  Duration,
  aws_appsync as appsync,
  aws_cloudwatch as cloudwatch,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * Telemetry — the CW (CloudWatch) observability layer for the backend.
 *
 * Owned by `ControlPlaneStack` (design.md: `control-plane/**` owns CP-1..4 +
 * CW). It publishes CloudWatch metrics for backend components and raises an
 * alarm whenever a published metric crosses its configured threshold
 * (Requirements 25.1, 25.2, 25.3).
 *
 * ## CP-3 subscription-delivery p95 (Requirement 25.2)
 *
 * The headline SLO metric is the **p95 latency of CP-3 subscription delivery**,
 * measured from a publish invocation to the moment the update is delivered to a
 * subscribed dashboard client (design.md "Observability (CW)"). AppSync does
 * not emit an end-to-end "publish → delivery" latency metric out of the box, so
 * the publish path (the CP-3 `publish*` fan-out resolvers / the AC + ML
 * publishers) emits raw per-delivery latency datapoints under a custom metric:
 *
 *   namespace  `1145/ControlPlane`
 *   metric     `SubscriptionDeliveryLatencyMillis`  (Unit: Milliseconds)
 *   dimension  `GraphQLAPIId = <CP-3 api id>`
 *
 * This construct is the single source of truth for those identifiers — the
 * publishers MUST emit datapoints under the exact same names (mirroring how the
 * WF-1 orchestrator shares `WF1_METRIC_NAMESPACE` / `WF1_FAILURE_METRIC`). The
 * construct defines the p95 view of that metric and an alarm on it.
 *
 * Validates: Requirements 25.1, 25.2, 25.3
 */

/** CloudWatch namespace for control-plane custom metrics (Requirement 25.1). */
export const CONTROL_PLANE_METRIC_NAMESPACE = '1145/ControlPlane';

/**
 * Custom metric name for CP-3 publish→delivery latency datapoints
 * (Requirement 25.2). The publish path emits one datapoint (in milliseconds)
 * per delivered subscription update; the alarm watches its p95.
 */
export const SUBSCRIPTION_DELIVERY_LATENCY_METRIC = 'SubscriptionDeliveryLatencyMillis';

/** Dimension that ties a metric to a specific CP-3 AppSync API. */
export const GRAPHQL_API_ID_DIMENSION = 'GraphQLAPIId';

/** AWS-published namespace for AppSync service metrics. */
export const APPSYNC_METRIC_NAMESPACE = 'AWS/AppSync';

/** Tunable alarm thresholds. All have defaults so callers can pass nothing. */
export interface TelemetryThresholds {
  /**
   * Alarm threshold (milliseconds) for the CP-3 subscription-delivery p95.
   * @default 2000
   */
  readonly subscriptionDeliveryP95Millis?: number;

  /**
   * Number of consecutive periods the p95 must breach before the alarm fires.
   * @default 3
   */
  readonly subscriptionDeliveryEvaluationPeriods?: number;

  /**
   * Alarm threshold (count) for CP-3 AppSync 5XX server errors in a period.
   * @default 5
   */
  readonly appsyncServerErrors?: number;
}

export interface TelemetryProps {
  /** The CP-3 AppSync API whose delivery SLO and errors are monitored. */
  readonly api: appsync.IGraphqlApi;

  /** Optional alarm threshold overrides. */
  readonly thresholds?: TelemetryThresholds;

  /**
   * Metric aggregation period for the alarms.
   * @default Duration.minutes(1)
   */
  readonly period?: Duration;
}

const DEFAULTS = {
  subscriptionDeliveryP95Millis: 2000,
  subscriptionDeliveryEvaluationPeriods: 3,
  appsyncServerErrors: 5,
};

export class Telemetry extends Construct {
  /** The CP-3 publish→delivery latency metric, viewed at p95 (Requirement 25.2). */
  readonly subscriptionDeliveryP95Metric: cloudwatch.Metric;

  /** Alarm that fires when the delivery p95 crosses its threshold (Req 25.3). */
  readonly subscriptionDeliveryAlarm: cloudwatch.Alarm;

  /** AppSync 5XX server-error metric for the CP-3 API (Requirement 25.1). */
  readonly appsyncServerErrorMetric: cloudwatch.Metric;

  /** Alarm that fires on a spike of CP-3 server errors (Requirement 25.3). */
  readonly appsyncServerErrorAlarm: cloudwatch.Alarm;

  /** Every alarm this construct owns, for assertions/diagnostics. */
  readonly alarms: cloudwatch.Alarm[];

  constructor(scope: Construct, id: string, props: TelemetryProps) {
    super(scope, id);

    const period = props.period ?? Duration.minutes(1);
    const t = { ...DEFAULTS, ...(props.thresholds ?? {}) };
    const apiDimensions = { [GRAPHQL_API_ID_DIMENSION]: props.api.apiId };

    // --- Req 25.2: CP-3 subscription-delivery p95 latency metric ----------
    //
    // Custom metric fed by the publish path (publish invocation → delivery).
    // We watch the p95 statistic so a long tail of slow deliveries trips the
    // dashboard-degradation alarm even when the median is healthy.
    this.subscriptionDeliveryP95Metric = new cloudwatch.Metric({
      namespace: CONTROL_PLANE_METRIC_NAMESPACE,
      metricName: SUBSCRIPTION_DELIVERY_LATENCY_METRIC,
      dimensionsMap: apiDimensions,
      statistic: 'p95',
      unit: cloudwatch.Unit.MILLISECONDS,
      period,
      label: 'CP-3 subscription delivery p95',
    });

    // --- Req 25.3: raise an alarm when the p95 crosses its threshold ------
    this.subscriptionDeliveryAlarm = this.subscriptionDeliveryP95Metric.createAlarm(
      this,
      'SubscriptionDeliveryP95Alarm',
      {
        alarmName: 'CP3-SubscriptionDelivery-p95',
        alarmDescription:
          'CP-3 live-update delivery p95 latency exceeded its SLO threshold — ' +
          'the operator dashboard may be lagging.',
        threshold: t.subscriptionDeliveryP95Millis,
        evaluationPeriods: t.subscriptionDeliveryEvaluationPeriods,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        // Missing data means no deliveries happened in the window — not a
        // breach, so don't flap the alarm into ALARM on a quiet period.
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );

    // --- Req 25.1: a backend-component metric + its alarm -----------------
    //
    // CP-3 AppSync 5XX server errors (AWS-published metric). A surge means the
    // live-state API itself is failing requests, independent of delivery
    // latency.
    this.appsyncServerErrorMetric = new cloudwatch.Metric({
      namespace: APPSYNC_METRIC_NAMESPACE,
      metricName: '5XXError',
      dimensionsMap: apiDimensions,
      statistic: 'Sum',
      unit: cloudwatch.Unit.COUNT,
      period,
      label: 'CP-3 AppSync 5XX errors',
    });

    this.appsyncServerErrorAlarm = this.appsyncServerErrorMetric.createAlarm(
      this,
      'AppSyncServerErrorAlarm',
      {
        alarmName: 'CP3-AppSync-5XXError',
        alarmDescription:
          'CP-3 AppSync is returning server (5XX) errors above threshold.',
        threshold: t.appsyncServerErrors,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );

    this.alarms = [
      this.subscriptionDeliveryAlarm,
      this.appsyncServerErrorAlarm,
    ];
  }
}
