import { App, Stack, aws_cognito as cognito } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { LiveStateApi } from '../appsync/live-state-api';
import {
  APPSYNC_METRIC_NAMESPACE,
  CONTROL_PLANE_METRIC_NAMESPACE,
  GRAPHQL_API_ID_DIMENSION,
  SUBSCRIPTION_DELIVERY_LATENCY_METRIC,
  Telemetry,
} from './telemetry';

/**
 * CP CW observability synth assertions (task 23.1 / Req 25.1, 25.2, 25.3).
 *
 * Confirms the Telemetry construct publishes the CP-3 subscription-delivery p95
 * metric (Req 25.2), monitors a backend-component metric (Req 25.1), and raises
 * CloudWatch alarms when a metric crosses its configured threshold (Req 25.3).
 *
 * Note: alarms whose metric carries dimensions are rendered by CDK using the
 * `Metrics` (math/MetricStat) form rather than the flat top-level
 * Namespace/MetricName/Stat keys, so assertions match against the nested
 * `MetricStat.Metric` shape.
 */
describe('Telemetry — CW metrics + alarms', () => {
  function build(): { template: Template; telemetry: Telemetry } {
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '111122223333', region: 'us-east-1' },
    });
    const userPool = new cognito.UserPool(stack, 'Pool');
    const api = new LiveStateApi(stack, 'LiveStateApi', { userPool });
    const telemetry = new Telemetry(stack, 'Telemetry', { api: api.api });
    return { template: Template.fromStack(stack), telemetry };
  }

  /** Match a MetricStat entry by namespace/metricName (+ optional stat). */
  function metricStat(namespace: string, metricName: string, stat?: string) {
    return Match.arrayWith([
      Match.objectLike({
        MetricStat: Match.objectLike({
          Metric: Match.objectLike({ Namespace: namespace, MetricName: metricName }),
          ...(stat ? { Stat: stat } : {}),
        }),
      }),
    ]);
  }

  it('publishes a CP-3 subscription-delivery p95 alarm on the custom metric (Req 25.2)', () => {
    const { template } = build();
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      ComparisonOperator: 'GreaterThanThreshold',
      Metrics: metricStat(
        CONTROL_PLANE_METRIC_NAMESPACE,
        SUBSCRIPTION_DELIVERY_LATENCY_METRIC,
        'p95',
      ),
    });
  });

  it('dimensions the delivery metric to the CP-3 AppSync API id', () => {
    const { template } = build();
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Metrics: Match.arrayWith([
        Match.objectLike({
          MetricStat: Match.objectLike({
            Metric: Match.objectLike({
              MetricName: SUBSCRIPTION_DELIVERY_LATENCY_METRIC,
              Dimensions: Match.arrayWith([
                Match.objectLike({ Name: GRAPHQL_API_ID_DIMENSION }),
              ]),
            }),
          }),
        }),
      ]),
    });
  });

  it('monitors a backend-component metric: CP-3 AppSync 5XX errors (Req 25.1)', () => {
    const { template } = build();
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Metrics: metricStat(APPSYNC_METRIC_NAMESPACE, '5XXError'),
    });
  });

  it('raises a CloudWatch alarm with a configured threshold (Req 25.3)', () => {
    const { template } = build();
    // Default delivery p95 threshold is 2000 ms over 3 periods.
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Threshold: 2000,
      EvaluationPeriods: 3,
      Metrics: metricStat(
        CONTROL_PLANE_METRIC_NAMESPACE,
        SUBSCRIPTION_DELIVERY_LATENCY_METRIC,
        'p95',
      ),
    });
  });

  it('creates exactly the two alarms the construct owns', () => {
    const { template, telemetry } = build();
    template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
    expect(telemetry.alarms).toHaveLength(2);
  });

  it('honors overridden thresholds', () => {
    const app = new App();
    const stack = new Stack(app, 'OverrideStack', {
      env: { account: '111122223333', region: 'us-east-1' },
    });
    const userPool = new cognito.UserPool(stack, 'Pool');
    const api = new LiveStateApi(stack, 'LiveStateApi', { userPool });
    new Telemetry(stack, 'Telemetry', {
      api: api.api,
      thresholds: {
        subscriptionDeliveryP95Millis: 500,
        subscriptionDeliveryEvaluationPeriods: 5,
      },
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Threshold: 500,
      EvaluationPeriods: 5,
      Metrics: metricStat(
        CONTROL_PLANE_METRIC_NAMESPACE,
        SUBSCRIPTION_DELIVERY_LATENCY_METRIC,
        'p95',
      ),
    });
  });
});
