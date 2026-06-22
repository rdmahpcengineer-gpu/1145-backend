import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { DataStack } from '../data/data-stack';
import { TenantProvisioning } from './kms/tenant-provisioning';
import { TenantUserPool } from './cognito/tenant-user-pool';
import { RestCommandApi } from './rest/rest-command-api';
import { LiveStateApi } from './appsync/live-state-api';
import { attachPublishResolvers } from './appsync/publish-resolvers';
import { Telemetry } from './observability/telemetry';

/**
 * ControlPlaneStack — owns `control-plane/**` (CP-1..4 + CW).
 *
 * The CP-4 per-tenant KMS strategy here is part of the first deploy wave; every
 * other stack depends on the table and keys.
 *
 * Filled in by later tasks:
 *  - 2.2 CP-4 per-tenant KMS strategy + tenant key resolver
 *  - 5.1 CP-1 Cognito tenant/operator user pool (exports pool id/ARN via wiring) ✅
 *  - 6.1 CP-2 SpecRestApi from imported openapi.yaml ✅
 *  - 7.1 CP-3 AppSync from imported SDL (exports api id via shared/wiring) ✅
 *  - 23.1 CW metrics + alarms (CP-3 delivery p95) ✅
 */
export interface ControlPlaneStackProps extends StackProps {
  /** DataStack reference for cross-stack wiring (table/keys). */
  readonly dataStack: DataStack;
}

export class ControlPlaneStack extends Stack {
  /** CP-4 per-tenant KMS provisioning (onboarding Lambda + scoped policy). */
  readonly tenantProvisioning: TenantProvisioning;

  /** CP-1 tenant/operator Cognito pool (CP-2 authorizer + CP-3 auth provider). */
  readonly tenantUserPool: TenantUserPool;

  /** CP-2 REST command API, built from the imported `openapi.yaml`. */
  readonly restCommandApi: RestCommandApi;

  /** CP-3 AppSync live-state API (schema loaded from the imported SDL). */
  readonly liveStateApi: LiveStateApi;

  /** CW telemetry — backend metrics + alarms, incl. CP-3 delivery p95 SLO. */
  readonly telemetry: Telemetry;

  constructor(scope: Construct, id: string, props: ControlPlaneStackProps) {
    super(scope, id, props);

    // 2.2 — CP-4 per-tenant KMS key strategy. Keys are minted per tenant at
    // onboarding time (alias/tenant/<tenantId>); see data/crypto/tenant_key.ts
    // for the resolver callers use instead of raw key ARNs.
    this.tenantProvisioning = new TenantProvisioning(this, 'TenantProvisioning');

    // 5.1 — CP-1 tenant/operator identity pool. A dedicated user pool with a
    // `custom:tenantId` attribute, separate from the investor-portal pool
    // (which lives in the frontend Amplify project and is never referenced
    // here). Tokens carry the tenant claim; CP-2 (task 6.x) builds an
    // authorizer from it and CP-3 (task 7.x) uses it as the Cognito auth
    // provider. Pool id/ARN are exported via shared/wiring.
    this.tenantUserPool = new TenantUserPool(this, 'TenantUserPool');

    // 6.1 — CP-2 REST command API. An API Gateway `SpecRestApi` built FROM the
    // imported `openapi.yaml` contract (the repo never re-declares paths/models
    // — R2.1/R2.2). The construct injects the CP-1 Cognito authorizer onto every
    // method (R2.3) and enables spec-driven request validation (R2.6). When the
    // `@alchemist/contracts` package is absent it falls back to a local stand-in
    // fixture so synth/tests still run. REST API id/root are exported via
    // shared/wiring for the command handlers added in task 6.2.
    this.restCommandApi = new RestCommandApi(this, 'RestCommandApi', {
      tenantUserPool: this.tenantUserPool,
    });

    // 7.1 — CP-3 AppSync live-state API. The GraphQL schema is LOADED from the
    // imported @alchemist/contracts graphql/schema.graphql SDL (never
    // re-authored in CDK). Auth modes: primary AMAZON_COGNITO_USER_POOLS (the
    // CP-1 pool) for Query/Subscription, additional AWS_IAM for the publish*
    // fan-out mutations. The API id is exported via shared/wiring
    // (WiringKeys.appsyncApiId). Resolvers are added by tasks 7.2 / 7.3.
    this.liveStateApi = new LiveStateApi(this, 'LiveStateApi', {
      userPool: this.tenantUserPool.userPool,
    });

    // 7.2 — CP-3 read/subscription resolvers. Wire the DM-2 single table as a
    // DynamoDB data source and attach the Query (getCall, listCalls) and
    // Subscription (onCallUpdate, onLead, onTranscript) resolvers. Every read
    // is pinned to PK = TENANT#<tenantId> derived from the Cognito identity in
    // the resolver context; any `tenant` argument is an additional filter that
    // can never widen scope beyond the session tenant (R3.5, R3.6). CP-3
    // accepts no user-facing writes (R3.8) — those arrive on CP-2 REST. The
    // publish fan-out resolvers (task 7.3) are attached separately.
    this.liveStateApi.attachReadResolvers(props.dataStack.table);

    // 7.3 — CP-3 publish (fan-out) resolvers. The four @aws_iam publish*
    // mutations (publishCallUpdate, appendTranscript, publishLead,
    // publishCallEscalated) are wired as no-op fan-out resolvers on a NONE
    // (local) data source: they set the tenant on the payload from the
    // session-derived tenantId supplied by the IAM caller (validated SE-1
    // session), perform NO persistent write, and return the payload so AppSync
    // delivers it to matching subscriptions (R3.7, 10.3, 11.3, 12.3). This
    // wiring is additive and lives in appsync/publish-resolvers.ts, separate
    // from the read-resolver wiring above.
    attachPublishResolvers(this.liveStateApi);

    // 23.1 — CW observability. The Telemetry construct publishes CloudWatch
    // metrics for backend components (Req 25.1) — including the p95 latency of
    // CP-3 subscription delivery measured publish-invocation → delivery (Req
    // 25.2) — and raises a CloudWatch alarm whenever a metric crosses its
    // configured threshold (Req 25.3). It reads the CP-3 GraphqlApi to dimension
    // the delivery-latency and AppSync error metrics; the publish path emits the
    // raw delivery datapoints under the shared metric identifiers exported by
    // the construct.
    this.telemetry = new Telemetry(this, 'Telemetry', {
      api: this.liveStateApi.api,
    });
  }
}
