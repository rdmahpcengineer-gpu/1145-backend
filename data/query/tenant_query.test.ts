import {
  DynamoQueryExecutor,
  DynamoQueryInput,
  TENANT_PK_PREFIX,
  TenantScopeError,
  buildTenantQuery,
  filterTenantItems,
  isValidTenantId,
  queryTenant,
  tenantPartitionKey,
} from './tenant_query';

const TABLE = 'DataTable';

describe('tenant_query — tenant scope validation', () => {
  it('accepts well-formed tenant ids', () => {
    expect(isValidTenantId('acme')).toBe(true);
    expect(isValidTenantId('tenant-123_AB')).toBe(true);
  });

  it('rejects empty, non-string, and unsafe tenant ids', () => {
    expect(isValidTenantId('')).toBe(false);
    expect(isValidTenantId(undefined)).toBe(false);
    expect(isValidTenantId('a/b')).toBe(false);
    expect(isValidTenantId('-leading')).toBe(false);
  });

  it('builds the partition key for a valid tenant', () => {
    expect(tenantPartitionKey('acme')).toBe(`${TENANT_PK_PREFIX}acme`);
    expect(tenantPartitionKey('acme')).toBe('TENANT#acme');
  });

  it('throws TenantScopeError for a missing tenant scope', () => {
    expect(() => tenantPartitionKey(undefined)).toThrow(TenantScopeError);
    expect(() => tenantPartitionKey(null)).toThrow(TenantScopeError);
    expect(() => tenantPartitionKey('')).toThrow(TenantScopeError);
  });

  it('throws TenantScopeError for an unsafe tenant scope', () => {
    expect(() => tenantPartitionKey('a/b')).toThrow(TenantScopeError);
    expect(() => tenantPartitionKey('with space')).toThrow(TenantScopeError);
  });
});

describe('tenant_query — buildTenantQuery pins PK = TENANT#<tenantId>', () => {
  it('pins the key condition to the tenant partition', () => {
    const q = buildTenantQuery(TABLE, { tenantId: 'acme' });
    expect(q.TableName).toBe(TABLE);
    expect(q.KeyConditionExpression).toBe('#pk = :pk');
    expect(q.ExpressionAttributeNames).toMatchObject({ '#pk': 'PK' });
    expect(q.ExpressionAttributeValues).toMatchObject({ ':pk': 'TENANT#acme' });
  });

  it('rejects building a query without a tenant scope BEFORE DynamoDB', () => {
    expect(() => buildTenantQuery(TABLE, { tenantId: '' })).toThrow(
      TenantScopeError,
    );
    expect(() =>
      buildTenantQuery(TABLE, { tenantId: undefined as unknown as string }),
    ).toThrow(TenantScopeError);
  });

  it('rejects a query with no table name', () => {
    expect(() => buildTenantQuery('', { tenantId: 'acme' })).toThrow(
      TenantScopeError,
    );
  });

  it('adds an equals sort-key condition', () => {
    const q = buildTenantQuery(TABLE, {
      tenantId: 'acme',
      sortKey: { kind: 'equals', value: 'BOOKING#1' },
    });
    expect(q.KeyConditionExpression).toBe('#pk = :pk AND #sk = :sk');
    expect(q.ExpressionAttributeNames).toMatchObject({ '#sk': 'SK' });
    expect(q.ExpressionAttributeValues).toMatchObject({
      ':pk': 'TENANT#acme',
      ':sk': 'BOOKING#1',
    });
  });

  it('adds a begins_with sort-key condition', () => {
    const q = buildTenantQuery(TABLE, {
      tenantId: 'acme',
      sortKey: { kind: 'beginsWith', prefix: 'ORDER#' },
    });
    expect(q.KeyConditionExpression).toBe(
      '#pk = :pk AND begins_with(#sk, :sk)',
    );
    expect(q.ExpressionAttributeValues).toMatchObject({ ':sk': 'ORDER#' });
  });

  it('adds a between sort-key condition with two bound values', () => {
    const q = buildTenantQuery(TABLE, {
      tenantId: 'acme',
      sortKey: { kind: 'between', lower: 'CALL#a', upper: 'CALL#z' },
    });
    expect(q.KeyConditionExpression).toBe(
      '#pk = :pk AND #sk BETWEEN :sk AND :skUpper',
    );
    expect(q.ExpressionAttributeValues).toMatchObject({
      ':sk': 'CALL#a',
      ':skUpper': 'CALL#z',
    });
  });

  it.each([
    ['lessThan', '<'],
    ['lessThanOrEqual', '<='],
    ['greaterThan', '>'],
    ['greaterThanOrEqual', '>='],
  ] as const)('adds a %s sort-key condition', (kind, op) => {
    const q = buildTenantQuery(TABLE, {
      tenantId: 'acme',
      sortKey: { kind, value: 'CALL#x' } as never,
    });
    expect(q.KeyConditionExpression).toBe(`#pk = :pk AND #sk ${op} :sk`);
  });

  it('layers an additional filter expression on top of the tenant scope', () => {
    const q = buildTenantQuery(TABLE, {
      tenantId: 'acme',
      filterExpression: '#et = :et',
      expressionAttributeNames: { '#et': 'entityType' },
      expressionAttributeValues: { ':et': 'Booking' },
    });
    // Tenant scope still pins the key condition...
    expect(q.KeyConditionExpression).toBe('#pk = :pk');
    // ...and the filter is layered on, never replacing it.
    expect(q.FilterExpression).toBe('#et = :et');
    expect(q.ExpressionAttributeNames).toMatchObject({
      '#pk': 'PK',
      '#et': 'entityType',
    });
    expect(q.ExpressionAttributeValues).toMatchObject({
      ':pk': 'TENANT#acme',
      ':et': 'Booking',
    });
  });

  it('passes through pagination, projection and index options', () => {
    const startKey = { PK: 'TENANT#acme', SK: 'ORDER#5' };
    const q = buildTenantQuery(TABLE, {
      tenantId: 'acme',
      indexName: 'GSI1',
      projectionExpression: 'PK, SK, #d',
      expressionAttributeNames: { '#d': 'data' },
      limit: 25,
      consistentRead: true,
      scanIndexForward: false,
      exclusiveStartKey: startKey,
    });
    expect(q.IndexName).toBe('GSI1');
    expect(q.ProjectionExpression).toBe('PK, SK, #d');
    expect(q.Limit).toBe(25);
    expect(q.ConsistentRead).toBe(true);
    expect(q.ScanIndexForward).toBe(false);
    expect(q.ExclusiveStartKey).toEqual(startKey);
  });
});

describe('tenant_query — filterTenantItems defense in depth', () => {
  it('keeps only items belonging to the requesting tenant (DocumentClient form)', () => {
    const items = [
      { PK: 'TENANT#acme', SK: 'BOOKING#1', tenantId: 'acme' },
      { PK: 'TENANT#other', SK: 'BOOKING#2', tenantId: 'other' },
      { PK: 'TENANT#acme', SK: 'ORDER#3', tenantId: 'acme' },
    ];
    const kept = filterTenantItems('acme', items);
    expect(kept).toHaveLength(2);
    expect(kept.every((i) => i.tenantId === 'acme')).toBe(true);
  });

  it('keeps only matching items (attribute-value form)', () => {
    const items = [
      { tenantId: { S: 'acme' } },
      { tenantId: { S: 'other' } },
    ];
    expect(filterTenantItems('acme', items)).toEqual([{ tenantId: { S: 'acme' } }]);
  });

  it('derives the tenant from PK when no tenantId attribute is present', () => {
    const items = [
      { PK: 'TENANT#acme', SK: 'CALL#1' },
      { PK: 'TENANT#other', SK: 'CALL#2' },
    ];
    expect(filterTenantItems('acme', items)).toEqual([
      { PK: 'TENANT#acme', SK: 'CALL#1' },
    ]);
  });

  it('drops items whose tenant cannot be resolved', () => {
    const items = [{ SK: 'ORPHAN#1' }, { PK: 'TENANT#acme', tenantId: 'acme' }];
    expect(filterTenantItems('acme', items)).toEqual([
      { PK: 'TENANT#acme', tenantId: 'acme' },
    ]);
  });

  it('returns an empty array for undefined/empty result sets', () => {
    expect(filterTenantItems('acme', undefined)).toEqual([]);
    expect(filterTenantItems('acme', [])).toEqual([]);
  });

  it('throws TenantScopeError when filtering without a valid tenant', () => {
    expect(() => filterTenantItems('', [])).toThrow(TenantScopeError);
  });
});

describe('tenant_query — queryTenant end to end', () => {
  function executorReturning(
    items: Record<string, unknown>[],
    lastKey?: Record<string, unknown>,
  ): { executor: DynamoQueryExecutor; seen: DynamoQueryInput[] } {
    const seen: DynamoQueryInput[] = [];
    const executor: DynamoQueryExecutor = {
      query: async (input) => {
        seen.push(input);
        return { Items: items, LastEvaluatedKey: lastKey };
      },
    };
    return { executor, seen };
  }

  it('builds a pinned query, runs it, and filters cross-tenant rows', async () => {
    // Simulate a table that (erroneously) returns a foreign row; it must be
    // stripped before reaching the caller.
    const { executor, seen } = executorReturning([
      { PK: 'TENANT#acme', SK: 'BOOKING#1', tenantId: 'acme' },
      { PK: 'TENANT#evil', SK: 'BOOKING#9', tenantId: 'evil' },
    ]);

    const result = await queryTenant(executor, TABLE, {
      tenantId: 'acme',
      sortKey: { kind: 'beginsWith', prefix: 'BOOKING#' },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].KeyConditionExpression).toBe(
      '#pk = :pk AND begins_with(#sk, :sk)',
    );
    expect(seen[0].ExpressionAttributeValues).toMatchObject({
      ':pk': 'TENANT#acme',
    });
    expect(result.items).toEqual([
      { PK: 'TENANT#acme', SK: 'BOOKING#1', tenantId: 'acme' },
    ]);
  });

  it('propagates the pagination cursor', async () => {
    const cursor = { PK: 'TENANT#acme', SK: 'ORDER#9' };
    const { executor } = executorReturning(
      [{ PK: 'TENANT#acme', tenantId: 'acme' }],
      cursor,
    );
    const result = await queryTenant(executor, TABLE, { tenantId: 'acme' });
    expect(result.lastEvaluatedKey).toEqual(cursor);
  });

  it('rejects an unscoped read before calling the executor', async () => {
    const { executor, seen } = executorReturning([]);
    await expect(
      queryTenant(executor, TABLE, { tenantId: '' }),
    ).rejects.toThrow(TenantScopeError);
    expect(seen).toHaveLength(0);
  });
});
