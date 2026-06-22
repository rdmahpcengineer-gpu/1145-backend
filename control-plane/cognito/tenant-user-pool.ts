import {
  RemovalPolicy,
  Stack,
  aws_apigateway as apigateway,
  aws_cognito as cognito,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { WiringKeys, publishWiring } from '../../shared/wiring';

/**
 * Name of the Cognito custom attribute that carries the operative tenant.
 *
 * Cognito surfaces declared custom attributes in issued tokens under the
 * `custom:` namespace, so the claim seen by downstream validators is
 * `custom:tenantId`. The tenant-derivation helper (task 5.2) reads
 * `validatedClaims["custom:tenantId"]`.
 */
export const TENANT_ID_ATTRIBUTE = 'tenantId';

/** The fully-qualified claim name as it appears in a verified token. */
export const TENANT_ID_CLAIM = `custom:${TENANT_ID_ATTRIBUTE}`;

/**
 * TenantUserPool — CP-1 tenant/operator identity pool.
 *
 * A dedicated Cognito `UserPool` for tenant/operator identities, owned by this
 * backend (design.md "CP-1"). It is physically and logically **separate** from
 * the investor-portal pool, which lives in the frontend's Amplify project and
 * is never referenced here (product.md: the two audiences are never merged).
 *
 * Each operator user carries a `custom:tenantId` attribute, populated at
 * provisioning/invitation time. Authentication issues tokens whose claims
 * include `tenantId` (surfaced as `custom:tenantId`), so every authorized
 * request carries a trustworthy tenant identity derived from the session
 * rather than from a client-supplied field.
 *
 * Consumers:
 *  - CP-2 (task 6.x) builds an API Gateway authorizer from this pool via
 *    {@link TenantUserPool.createRestApiAuthorizer}.
 *  - CP-3 (task 7.x) uses this pool as the `AMAZON_COGNITO_USER_POOLS` auth
 *    provider for reads/subscriptions; it reads the pool id/ARN exported here.
 *
 * Validates: Requirements 1.1, 1.2, 1.3
 */
export interface TenantUserPoolProps {
  /**
   * Optional logical name for the user pool. Defaults to a backend-scoped name
   * that makes the tenant/operator audience explicit and distinguishes it from
   * any investor-portal pool.
   */
  readonly userPoolName?: string;
}

export class TenantUserPool extends Construct {
  /** The CP-1 tenant/operator user pool (the CP-3 auth provider). */
  readonly userPool: cognito.UserPool;

  /** App client used by the operator dashboard to authenticate. */
  readonly userPoolClient: cognito.UserPoolClient;

  /** Convenience accessor for cross-stack consumers. */
  readonly userPoolId: string;

  /** Convenience accessor for cross-stack consumers. */
  readonly userPoolArn: string;

  constructor(scope: Construct, id: string, props: TenantUserPoolProps = {}) {
    super(scope, id);

    // --- CP-1 tenant/operator user pool ----------------------------------
    //
    // This pool serves ONLY the tenant/operator audience. The investor-portal
    // pool is a separate resource in the frontend Amplify project and must
    // never be referenced from this backend (R1.2 — pools are never merged).
    this.userPool = new cognito.UserPool(this, 'Pool', {
      userPoolName: props.userPoolName ?? '1145-tenant-operator',
      // Operators are invited/provisioned (their tenant is assigned at that
      // time); they do not self-register an arbitrary tenant.
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      // The tenant claim. Declared as a custom attribute so Cognito emits it
      // as `custom:tenantId` in issued tokens (R1.3). Mutable so an operator's
      // tenant can be (re)assigned at provisioning time, but it is only ever
      // set by the backend/admin, never self-served.
      customAttributes: {
        [TENANT_ID_ATTRIBUTE]: new cognito.StringAttribute({
          minLen: 1,
          maxLen: 256,
          mutable: true,
        }),
      },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // An identity pool of real operators — never auto-destroy on teardown.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Dashboard app client. It reads the tenant claim so the verified token
    // carries `custom:tenantId` for the tenant-derivation helper (task 5.2).
    const clientAttributes = new cognito.ClientAttributes()
      .withStandardAttributes({ email: true })
      .withCustomAttributes(TENANT_ID_ATTRIBUTE);

    this.userPoolClient = this.userPool.addClient('DashboardClient', {
      userPoolClientName: '1145-operator-dashboard',
      authFlows: { userSrp: true },
      readAttributes: clientAttributes,
      // The tenant attribute is admin/provisioning-owned: the client may read
      // it from the token but cannot write it back.
      writeAttributes: new cognito.ClientAttributes().withStandardAttributes({
        email: true,
      }),
      preventUserExistenceErrors: true,
    });

    this.userPoolId = this.userPool.userPoolId;
    this.userPoolArn = this.userPool.userPoolArn;

    // Export the pool id/ARN for cross-stack consumers (CP-2 authorizer in
    // task 6.x, CP-3 Cognito auth provider in task 7.x) via the shared wiring
    // convention (stack output + SSM parameter).
    publishWiring(this, WiringKeys.cognitoUserPoolId, this.userPoolId);
    publishWiring(this, WiringKeys.cognitoUserPoolArn, this.userPoolArn);
  }

  /**
   * Build an API Gateway Cognito authorizer backed by this pool, for CP-2
   * (task 6.x) to attach to every REST method. Kept here so the REST API never
   * needs to know how the tenant/operator pool is constructed — it only knows
   * that requests are authorized against the CP-1 pool.
   */
  createRestApiAuthorizer(
    scope: Construct,
    id: string,
  ): apigateway.CognitoUserPoolsAuthorizer {
    return new apigateway.CognitoUserPoolsAuthorizer(scope, id, {
      cognitoUserPools: [this.userPool],
      authorizerName: 'cp1-tenant-operator',
      identitySource: apigateway.IdentitySource.header('Authorization'),
    });
  }

  /** The stack this construct belongs to (helper for consumers). */
  get stack(): Stack {
    return Stack.of(this);
  }
}
