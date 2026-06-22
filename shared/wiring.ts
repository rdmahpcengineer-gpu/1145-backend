/**
 * Cross-stack wiring conventions.
 *
 * Stacks in this app are deliberately decoupled: a producing stack publishes a
 * value as both a CloudFormation stack output and an SSM parameter, and a
 * consuming stack reads it back by the same well-known name. This avoids hard
 * CloudFormation export/import coupling for values that are looked up at deploy
 * time (table names, KMS alias maps, AppSync API IDs, state-machine ARNs).
 *
 * See design.md "CDK organization": cross-stack references are passed via stack
 * outputs / SSM parameters.
 */

import { aws_ssm as ssm, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';

/** Root namespace for every SSM parameter this app publishes. */
export const APP_NAMESPACE = '/1145/aws-backend';

/** Well-known cross-stack parameter keys (filled in by later tasks). */
export const WiringKeys = {
  /** DM-2 DynamoDB single-table name (DataStack -> everyone). */
  dataTableName: 'data/table-name',
  /** DM-1 Redis short-term store primary endpoint address (DataStack -> agent). */
  redisPrimaryEndpoint: 'data/redis-endpoint',
  /** DM-1 Redis short-term store port (DataStack -> agent). */
  redisPort: 'data/redis-port',
  /** DM-4 S3 object-lake bucket name (DataStack -> agent/ml/workflows). */
  objectLakeBucketName: 'data/object-lake-bucket-name',
  /** CP-1 Cognito tenant/operator user pool id (ControlPlaneStack -> CP-2/CP-3). */
  cognitoUserPoolId: 'control-plane/cognito-user-pool-id',
  /** CP-1 Cognito tenant/operator user pool ARN (ControlPlaneStack -> CP-2/CP-3). */
  cognitoUserPoolArn: 'control-plane/cognito-user-pool-arn',
  /** CP-2 API Gateway REST API id (ControlPlaneStack -> command handlers/clients). */
  restApiId: 'control-plane/rest-api-id',
  /** CP-2 API Gateway REST API root resource id (ControlPlaneStack -> handler wiring). */
  restApiRootResourceId: 'control-plane/rest-api-root-resource-id',
  /** CP-3 AppSync GraphQL API id (ControlPlaneStack -> agent/ml publishers). */
  appsyncApiId: 'control-plane/appsync-api-id',
  /** WF-1 Step Functions state-machine ARN (WorkflowStack -> control-plane/agent). */
  workflowStateMachineArn: 'workflows/state-machine-arn',
} as const;

/** Build the fully-qualified SSM parameter name for a wiring key. */
export function paramName(key: string): string {
  return `${APP_NAMESPACE}/${key}`;
}

/**
 * Publish a cross-stack value as an SSM string parameter and a stack output.
 * Producing stacks call this; consuming stacks call {@link readWiring}.
 */
export function publishWiring(scope: Construct, key: string, value: string): ssm.StringParameter {
  const param = new ssm.StringParameter(scope, `Wiring-${sanitize(key)}`, {
    parameterName: paramName(key),
    stringValue: value,
  });
  new CfnOutput(scope, `WiringOut-${sanitize(key)}`, {
    value,
    exportName: `${sanitize(key)}`,
  });
  return param;
}

/** Read a cross-stack value previously published via {@link publishWiring}. */
export function readWiring(scope: Construct, key: string): string {
  return ssm.StringParameter.valueForStringParameter(scope, paramName(key));
}

function sanitize(key: string): string {
  return key.replace(/[^A-Za-z0-9]/g, '-');
}
