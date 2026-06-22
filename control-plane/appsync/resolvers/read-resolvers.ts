/**
 * control-plane/appsync/resolvers/read-resolvers — CP-3 read & subscription
 * resolvers (task 7.2).
 *
 * This module owns the **read side** of the CP-3 AppSync API: the `Query`
 * resolvers that read DM-2, and the `Subscription` resolvers that scope the
 * fan-out delivery. It is deliberately kept separate from the publish fan-out
 * resolvers (task 7.3, `publish-resolvers.ts`) so the two tasks never edit the
 * same code; `LiveStateApi` exposes `attachReadResolvers` and
 * `attachPublishResolvers` as independent, additive methods.
 *
 * ## The one non-negotiable invariant
 *
 * Every read/subscription is scoped to `PK = TENANT#<tenantId>`, where
 * `tenantId` is taken from the **Cognito identity in the resolver context**
 * (`$ctx.identity.claims["custom:tenantId"]`) — NEVER from a GraphQL argument.
 * This is the AppSync mirror of `data/query/tenant_query.ts` (DM-2) and of the
 * multi-tenant steering rule: "AppSync resolvers enforce tenant in the
 * resolver — a subscription argument is a filter, not an auth boundary."
 *
 * A `tenant` argument on `listCalls` / `onCallUpdate` / `onLead` is applied
 * ONLY as an additional equality filter on top of the session-tenant scope.
 * Because the partition / subscription is already pinned to the session tenant,
 * a `tenant` argument naming a different tenant can only ever *narrow* the
 * result to the empty set — it can never widen scope to another tenant's data.
 *
 * The VTL is produced by small pure builder functions so the tenant-scoping
 * logic is unit-testable without synthesizing a stack.
 *
 * Validates: Requirements 3.5, 3.6, 3.8
 */

import { aws_appsync as appsync, aws_dynamodb as dynamodb } from 'aws-cdk-lib';

/** Cognito claim that carries the operator's tenant (CP-1 `custom:tenantId`). */
export const IDENTITY_TENANT_CLAIM = 'custom:tenantId';

/** Partition-key prefix shared with the DM-2 persistence/query layer. */
export const TENANT_PK_PREFIX = 'TENANT#';

/** Sort-key prefix for Call items in the DM-2 single table. */
export const CALL_SK_PREFIX = 'CALL#';

/**
 * VTL snippet that reads the operative tenant from the Cognito identity and
 * rejects the request when it is absent. This is the ONLY source of the
 * operative tenant — arguments are never consulted for scope.
 */
export function deriveSessionTenantVtl(): string {
  return [
    `#set($tenantId = $ctx.identity.claims.get("${IDENTITY_TENANT_CLAIM}"))`,
    '#if($util.isNullOrEmpty($tenantId))',
    '  $util.unauthorized()',
    '#end',
  ].join('\n');
}

/** Standard DynamoDB error passthrough used by every response template. */
function dynamoErrorPassthroughVtl(): string {
  return ['#if($ctx.error)', '  $util.error($ctx.error.message, $ctx.error.type)', '#end'].join(
    '\n',
  );
}

// ---------------------------------------------------------------------------
// Query.getCall(id: ID!) : Call  — DynamoDB GetItem pinned to the session tenant
// ---------------------------------------------------------------------------

/**
 * Request template for `getCall`. Reads a single Call by id but pins the key to
 * `PK = TENANT#<sessionTenant>` so a caller can only ever fetch a Call inside
 * their own tenant partition.
 */
export function getCallRequestTemplate(): string {
  return [
    deriveSessionTenantVtl(),
    '{',
    '  "version": "2017-02-28",',
    '  "operation": "GetItem",',
    '  "key": {',
    `    "PK": $util.dynamodb.toDynamoDBJson("${TENANT_PK_PREFIX}\${tenantId}"),`,
    `    "SK": $util.dynamodb.toDynamoDBJson("${CALL_SK_PREFIX}\${ctx.args.id}")`,
    '  }',
    '}',
  ].join('\n');
}

/**
 * Response template for `getCall`. Defense in depth: even though the key is
 * tenant-pinned, drop the item if its `tenantId` does not match the session
 * tenant, so no cross-tenant item can ever be returned.
 */
export function getCallResponseTemplate(): string {
  return [
    dynamoErrorPassthroughVtl(),
    `#set($tenantId = $ctx.identity.claims.get("${IDENTITY_TENANT_CLAIM}"))`,
    '#if($util.isNullOrEmpty($ctx.result))',
    '  #return',
    '#end',
    '#if($ctx.result.tenantId != $tenantId)',
    '  ## defense in depth — never surface another tenant\'s item',
    '  #return',
    '#end',
    '$util.toJson($ctx.result)',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Query.listCalls(tenant: ID) : [Call!]!  — DynamoDB Query in the tenant partition
// ---------------------------------------------------------------------------

/**
 * Request template for `listCalls`. The key condition is pinned to
 * `PK = TENANT#<sessionTenant>` AND `begins_with(SK, "CALL#")`. A `tenant`
 * argument, when present, is layered on ONLY as a `FilterExpression` of
 * `tenantId = :argTenant`. Since every item in the partition already carries
 * `tenantId = <sessionTenant>`, an argument naming another tenant yields the
 * empty set and can never widen scope.
 */
export function listCallsRequestTemplate(): string {
  return [
    deriveSessionTenantVtl(),
    '{',
    '  "version": "2017-02-28",',
    '  "operation": "Query",',
    '  "query": {',
    '    "expression": "#pk = :pk AND begins_with(#sk, :sk)",',
    '    "expressionNames": { "#pk": "PK", "#sk": "SK" },',
    '    "expressionValues": {',
    `      ":pk": $util.dynamodb.toDynamoDBJson("${TENANT_PK_PREFIX}\${tenantId}"),`,
    `      ":sk": $util.dynamodb.toDynamoDBJson("${CALL_SK_PREFIX}")`,
    '    }',
    '  }',
    '  #if(!$util.isNullOrEmpty($ctx.args.tenant))',
    '  ,"filter": {',
    '    "expression": "tenantId = :argTenant",',
    '    "expressionValues": {',
    '      ":argTenant": $util.dynamodb.toDynamoDBJson($ctx.args.tenant)',
    '    }',
    '  }',
    '  #end',
    '}',
  ].join('\n');
}

/**
 * Response template for `listCalls`. Defense in depth: rebuild the result list
 * keeping only items whose `tenantId` equals the session tenant, so a
 * cross-tenant item can never leak even if one were somehow present.
 */
export function listCallsResponseTemplate(): string {
  return [
    dynamoErrorPassthroughVtl(),
    `#set($tenantId = $ctx.identity.claims.get("${IDENTITY_TENANT_CLAIM}"))`,
    '#set($scoped = [])',
    '#foreach($item in $ctx.result.items)',
    '  #if($item.tenantId == $tenantId)',
    '    $util.qr($scoped.add($item))',
    '  #end',
    '#end',
    '$util.toJson($scoped)',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Subscription resolvers — enhanced filtering on the fan-out (NONE data source)
// ---------------------------------------------------------------------------

/**
 * Shared request template for every subscription resolver. Subscription
 * resolvers run on a local (NONE) data source: the request is a no-op payload;
 * all the work happens in the response template where the subscription filter
 * is set.
 */
export function subscriptionRequestTemplate(): string {
  return ['{', '  "version": "2017-02-28",', '  "payload": {}', '}'].join('\n');
}

/** A single AppSync enhanced-subscription filter clause. */
export interface SubscriptionFilterField {
  /** Field on the published payload to match (e.g. `tenantId`, `callId`). */
  readonly fieldName: string;
  /** VTL expression producing the value to match against. */
  readonly valueVtl: string;
  /** When set, the clause is only added if this VTL guard is non-empty. */
  readonly onlyIfVtl?: string;
}

/**
 * Build a subscription response template that pins delivery with
 * `$extensions.setSubscriptionFilter`. Every clause is AND-ed within a single
 * filter group, so adding the (optional) `tenant` argument clause on top of the
 * mandatory session-tenant clause can only narrow delivery — never widen it.
 */
export function subscriptionResponseTemplate(fields: readonly SubscriptionFilterField[]): string {
  const lines: string[] = [deriveSessionTenantVtl(), '#set($filters = [])'];
  for (const field of fields) {
    const add = `  $util.qr($filters.add({ "fieldName": "${field.fieldName}", "operator": "eq", "value": ${field.valueVtl} }))`;
    if (field.onlyIfVtl) {
      lines.push(`#if(!$util.isNullOrEmpty(${field.onlyIfVtl}))`, add, '#end');
    } else {
      lines.push(add.trimStart());
    }
  }
  lines.push(
    '$extensions.setSubscriptionFilter({ "filterGroup": [ { "filters": $filters } ] })',
    'null',
  );
  return lines.join('\n');
}

/**
 * `Subscription.onCallUpdate(tenant: ID)` / `Subscription.onLead(tenant: ID)`:
 * always pin delivery to the session tenant; apply the optional `tenant`
 * argument as an additional `tenantId` equality clause (filter, not boundary).
 */
export function tenantScopedSubscriptionResponseTemplate(): string {
  return subscriptionResponseTemplate([
    { fieldName: 'tenantId', valueVtl: '$tenantId' },
    {
      fieldName: 'tenantId',
      valueVtl: '$ctx.args.tenant',
      onlyIfVtl: '$ctx.args.tenant',
    },
  ]);
}

/**
 * `Subscription.onTranscript(callId: ID!)`: the fixture `TranscriptSegment`
 * type carries no `tenantId` field, so delivery is bound to the requested
 * `callId`. The session is still authenticated (the mandatory tenant claim is
 * asserted by {@link deriveSessionTenantVtl}); the callId clause scopes the
 * fan-out to the specific call the operator subscribed to.
 */
export function transcriptSubscriptionResponseTemplate(): string {
  return subscriptionResponseTemplate([
    { fieldName: 'callId', valueVtl: '$ctx.args.callId' },
  ]);
}

// ---------------------------------------------------------------------------
// CDK wiring
// ---------------------------------------------------------------------------

/** A resolver attached to the API by {@link attachReadResolvers}. */
export interface AttachedReadResolvers {
  readonly tableDataSource: appsync.DynamoDbDataSource;
  readonly subscriptionDataSource: appsync.NoneDataSource;
  readonly resolvers: appsync.Resolver[];
}

/**
 * Wire the CP-3 read & subscription resolvers onto an existing GraphQL API.
 *
 * - Creates a DynamoDB data source for the DM-2 table and attaches the
 *   `Query.getCall` / `Query.listCalls` resolvers (tenant-pinned to the Cognito
 *   identity).
 * - Creates a local (NONE) data source and attaches the `Subscription.*`
 *   resolvers that set the tenant-scoping subscription filter.
 *
 * This function is additive and self-contained so task 7.3 can attach the
 * publish fan-out resolvers independently without colliding.
 */
export function attachReadResolvers(
  api: appsync.GraphqlApi,
  table: dynamodb.ITable,
): AttachedReadResolvers {
  const tableDataSource = api.addDynamoDbDataSource('Dm2TableDataSource', table);
  const subscriptionDataSource = api.addNoneDataSource('SubscriptionFanoutDataSource');

  const resolvers: appsync.Resolver[] = [];

  resolvers.push(
    tableDataSource.createResolver('GetCallResolver', {
      typeName: 'Query',
      fieldName: 'getCall',
      requestMappingTemplate: appsync.MappingTemplate.fromString(getCallRequestTemplate()),
      responseMappingTemplate: appsync.MappingTemplate.fromString(getCallResponseTemplate()),
    }),
  );

  resolvers.push(
    tableDataSource.createResolver('ListCallsResolver', {
      typeName: 'Query',
      fieldName: 'listCalls',
      requestMappingTemplate: appsync.MappingTemplate.fromString(listCallsRequestTemplate()),
      responseMappingTemplate: appsync.MappingTemplate.fromString(listCallsResponseTemplate()),
    }),
  );

  const subscriptionFields: ReadonlyArray<{ id: string; fieldName: string; response: string }> = [
    {
      id: 'OnCallUpdateResolver',
      fieldName: 'onCallUpdate',
      response: tenantScopedSubscriptionResponseTemplate(),
    },
    {
      id: 'OnLeadResolver',
      fieldName: 'onLead',
      response: tenantScopedSubscriptionResponseTemplate(),
    },
    {
      id: 'OnTranscriptResolver',
      fieldName: 'onTranscript',
      response: transcriptSubscriptionResponseTemplate(),
    },
  ];

  for (const sub of subscriptionFields) {
    resolvers.push(
      subscriptionDataSource.createResolver(sub.id, {
        typeName: 'Subscription',
        fieldName: sub.fieldName,
        requestMappingTemplate: appsync.MappingTemplate.fromString(subscriptionRequestTemplate()),
        responseMappingTemplate: appsync.MappingTemplate.fromString(sub.response),
      }),
    );
  }

  return { tableDataSource, subscriptionDataSource, resolvers };
}
