import * as path from 'path';
import { Duration, Stack } from 'aws-cdk-lib';
import { aws_iam as iam, aws_lambda as lambda } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { TENANT_KEY_ALIAS_PREFIX } from '../../data/crypto/tenant_key';

/**
 * TenantProvisioning — CP-4 per-tenant KMS key strategy.
 *
 * Provisions an onboarding Lambda that mints a dedicated symmetric KMS key for
 * each tenant **at onboarding time**, registered under the alias
 * `alias/tenant/<tenantId>`. Keys are created per tenant (not statically at
 * synth), so the key set scales with the tenant population (design.md CP-4).
 *
 * Each key's policy restricts encrypt/decrypt to the roles operating within
 * that tenant's context, pinned by the `tenant` encryption context — there are
 * no cross-tenant grants. Callers resolve the right key through
 * `data/crypto/tenant_key#keyForTenant`, never by passing a raw ARN.
 *
 * Validates: Requirements 4.1, 4.2, 4.3
 */
export interface TenantProvisioningProps {
  /**
   * ARNs of the data-plane roles that operate within a tenant's context and may
   * use a tenant's key (always bound to that tenant's encryption context in the
   * generated key policy). Optional; data-plane roles are wired in by later
   * tasks, so this defaults to none (root-administered key only).
   */
  readonly tenantOperatorRoleArns?: string[];
}

export class TenantProvisioning extends Construct {
  /** The onboarding Lambda invoked per tenant to create that tenant's key. */
  readonly onboardingFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: TenantProvisioningProps = {}) {
    super(scope, id);

    const stack = Stack.of(this);

    this.onboardingFunction = new lambda.Function(this, 'OnboardTenant', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'onboarding')),
      timeout: Duration.minutes(1),
      description:
        'CP-4 tenant onboarding: creates a per-tenant KMS key under alias/tenant/<tenantId>',
      environment: {
        TENANT_KEY_ALIAS_PREFIX,
        TENANT_OPERATOR_ROLE_ARNS: JSON.stringify(
          props.tenantOperatorRoleArns ?? [],
        ),
        AWS_ACCOUNT_ID: stack.account,
        AWS_PARTITION: stack.partition,
      },
    });

    // kms:CreateKey cannot be resource-scoped (the key does not exist yet);
    // this grants only key *creation* and tagging, not use of existing keys.
    this.onboardingFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'CreateTenantKeys',
        actions: ['kms:CreateKey', 'kms:TagResource'],
        resources: ['*'],
      }),
    );

    // Alias/policy management is scoped to the tenant alias namespace and keys
    // in this account/region — never to other accounts.
    this.onboardingFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ManageTenantKeyAliasesAndPolicies',
        actions: [
          'kms:CreateAlias',
          'kms:UpdateAlias',
          'kms:DeleteAlias',
          'kms:PutKeyPolicy',
          'kms:DescribeKey',
        ],
        resources: [
          stack.formatArn({ service: 'kms', resource: 'alias', resourceName: 'tenant/*' }),
          stack.formatArn({ service: 'kms', resource: 'key', resourceName: '*' }),
        ],
      }),
    );
  }
}
