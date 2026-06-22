import * as fc from 'fast-check';
import {
  CALL_SK_PREFIX,
  IDENTITY_TENANT_CLAIM,
  TENANT_PK_PREFIX,
  deriveSessionTenantVtl,
  getCallRequestTemplate,
  getCallResponseTemplate,
  listCallsRequestTemplate,
  listCallsResponseTemplate,
  subscriptionRequestTemplate,
  subscriptionResponseTemplate,
  tenantScopedSubscriptionResponseTemplate,
  transcriptSubscriptionResponseTemplate,
} from './read-resolvers';

/**
 * Unit tests for the CP-3 read/subscription resolver tenant-scoping logic
 * (task 7.2 / Req 3.5, 3.6, 3.8).
 *
 * These assert on the generated VTL so the non-negotiable invariants are
 * locked in without synthesizing a stack:
 *   - the operative tenant is taken from the Cognito identity claim, never an
 *     argument (Req 3.5);
 *   - reads pin the partition key to `TENANT#<tenantId>` (Req 3.5);
 *   - a `tenant` argument is layered on only as an additional equality filter
 *     and can never widen scope (Req 3.6).
 */
describe('read-resolvers — tenant-scoping VTL', () => {
  describe('deriveSessionTenantVtl', () => {
    it('reads the tenant from the Cognito identity claim, not an argument', () => {
      const vtl = deriveSessionTenantVtl();
      expect(vtl).toContain(`$ctx.identity.claims.get("${IDENTITY_TENANT_CLAIM}")`);
      expect(vtl).not.toContain('$ctx.args');
    });

    it('rejects the request when the session tenant is absent', () => {
      const vtl = deriveSessionTenantVtl();
      expect(vtl).toContain('$util.isNullOrEmpty($tenantId)');
      expect(vtl).toContain('$util.unauthorized()');
    });
  });

  describe('getCall', () => {
    it('pins the GetItem key to the session tenant partition', () => {
      const vtl = getCallRequestTemplate();
      expect(vtl).toContain('"operation": "GetItem"');
      expect(vtl).toContain(
        `$util.dynamodb.toDynamoDBJson("${TENANT_PK_PREFIX}\${tenantId}")`,
      );
      expect(vtl).toContain(
        `$util.dynamodb.toDynamoDBJson("${CALL_SK_PREFIX}\${ctx.args.id}")`,
      );
    });

    it('derives the partition tenant from identity, never from arguments', () => {
      const vtl = getCallRequestTemplate();
      // The PK value is built from $tenantId (claim-derived), and the only use
      // of args is the SK id lookup — never the tenant scope.
      expect(vtl).toContain(`$ctx.identity.claims.get("${IDENTITY_TENANT_CLAIM}")`);
      const pkLine = vtl.split('\n').find((l) => l.includes('"PK"'))!;
      expect(pkLine).toContain('${tenantId}');
      expect(pkLine).not.toContain('$ctx.args');
    });

    it('drops items whose tenantId does not match the session tenant', () => {
      const vtl = getCallResponseTemplate();
      expect(vtl).toContain('#if($ctx.result.tenantId != $tenantId)');
      expect(vtl).toContain('#return');
    });
  });

  describe('listCalls', () => {
    it('pins the key condition to the tenant partition and Call sort prefix', () => {
      const vtl = listCallsRequestTemplate();
      expect(vtl).toContain('"operation": "Query"');
      expect(vtl).toContain('#pk = :pk AND begins_with(#sk, :sk)');
      expect(vtl).toContain(
        `$util.dynamodb.toDynamoDBJson("${TENANT_PK_PREFIX}\${tenantId}")`,
      );
      expect(vtl).toContain(`$util.dynamodb.toDynamoDBJson("${CALL_SK_PREFIX}")`);
    });

    it('applies the tenant argument only as an additional filter', () => {
      const vtl = listCallsRequestTemplate();
      // The tenant arg is conditional and lives under "filter", never in the
      // key condition (which is what defines the partition scope).
      expect(vtl).toContain('#if(!$util.isNullOrEmpty($ctx.args.tenant))');
      expect(vtl).toContain('"filter"');
      expect(vtl).toContain('"expression": "tenantId = :argTenant"');
      const keyConditionLine = vtl
        .split('\n')
        .find((l) => l.includes('begins_with(#sk, :sk)'))!;
      expect(keyConditionLine).not.toContain('args.tenant');
    });

    it('filters returned items down to the session tenant (defense in depth)', () => {
      const vtl = listCallsResponseTemplate();
      expect(vtl).toContain('#if($item.tenantId == $tenantId)');
      expect(vtl).toContain('$util.qr($scoped.add($item))');
      expect(vtl).toContain('$util.toJson($scoped)');
    });
  });

  describe('subscription resolvers', () => {
    it('request template is a no-op local payload', () => {
      expect(subscriptionRequestTemplate()).toContain('"payload": {}');
    });

    it('tenant-scoped subscription always pins delivery to the session tenant', () => {
      const vtl = tenantScopedSubscriptionResponseTemplate();
      expect(vtl).toContain('$extensions.setSubscriptionFilter');
      expect(vtl).toContain('"fieldName": "tenantId", "operator": "eq", "value": $tenantId');
      // Session-tenant clause is unconditional; the arg clause is conditional.
      expect(vtl).toContain('#if(!$util.isNullOrEmpty($ctx.args.tenant))');
    });

    it('applies the tenant argument as an additional (narrowing) filter clause', () => {
      const vtl = tenantScopedSubscriptionResponseTemplate();
      const argClause =
        '"fieldName": "tenantId", "operator": "eq", "value": $ctx.args.tenant';
      expect(vtl).toContain(argClause);
      // Both clauses target tenantId with eq — AND-ed, so a differing arg can
      // only produce the empty set, never another tenant's data.
      const occurrences = vtl.split('"fieldName": "tenantId"').length - 1;
      expect(occurrences).toBe(2);
    });

    it('transcript subscription scopes delivery to the requested callId', () => {
      const vtl = transcriptSubscriptionResponseTemplate();
      expect(vtl).toContain(
        '"fieldName": "callId", "operator": "eq", "value": $ctx.args.callId',
      );
      // Still asserts an authenticated tenant session even though the fixture
      // TranscriptSegment carries no tenantId field.
      expect(vtl).toContain('$util.unauthorized()');
    });

    it('subscriptionResponseTemplate AND-s all clauses in one filter group', () => {
      const vtl = subscriptionResponseTemplate([
        { fieldName: 'tenantId', valueVtl: '$tenantId' },
        { fieldName: 'callId', valueVtl: '$ctx.args.callId' },
      ]);
      expect(vtl).toContain('"filterGroup": [ { "filters": $filters } ]');
      expect((vtl.match(/\$filters\.add/g) ?? []).length).toBe(2);
    });
  });

  describe('property: a tenant argument can never widen scope', () => {
    it('always emits the unconditional session-tenant clause regardless of args', () => {
      // For any session tenant and any (possibly conflicting) tenant argument,
      // the generated VTL still pins the mandatory session-tenant clause; the
      // argument is only ever an additional clause. The template is static, so
      // we assert the structural invariant holds for all string inputs.
      fc.assert(
        fc.property(fc.string(), fc.string(), (_sessionTenant, _argTenant) => {
          const vtl = tenantScopedSubscriptionResponseTemplate();
          // mandatory session clause present
          const sessionClause =
            '"fieldName": "tenantId", "operator": "eq", "value": $tenantId';
          // arg clause guarded by an isNullOrEmpty check (cannot replace it)
          const guarded = vtl.includes('#if(!$util.isNullOrEmpty($ctx.args.tenant))');
          return vtl.includes(sessionClause) && guarded;
        }),
        { numRuns: 100 },
      );
    });
  });
});
