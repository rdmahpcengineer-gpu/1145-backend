/**
 * data/query/tenant_query — shared tenant query builder (DM-2 reads).
 *
 * Single source of truth for "how every read path queries the DM-2 single
 * table". Used by all read paths (CP-3 resolvers, AC-3 memory hydration,
 * workflow look-ups). It enforces the cross-cutting multi-tenant invariant on
 * the READ side, the mirror of the persistence wrapper on the write side:
 *
 *   1. Every read builds a `KeyConditionExpression` pinned to
 *      `PK = TENANT#<tenantId>` — a query can never span partitions.
 *   2. A query that lacks a tenant scope is rejected with a typed
 *      {@link TenantScopeError} BEFORE any DynamoDB call is issued.
 *   3. As defense in depth, any item whose `tenantId` does not match the
 *      requesting tenant is filtered out of the results, so no cross-tenant
 *      item is ever returned even if the table somehow held one.
 *
 * Note: the `TENANT#<tenantId>` partition-key helper is defined locally here
 * (rather than imported from the persistence wrapper) so the read and write
 * paths stay independently owned; both deliberately agree on the same prefix.
 *
 * Validates: Requirements 5.2, 5.5, 18.3
 */

/** Partition-key prefix shared by every tenant-partitioned item. */
export const TENANT_PK_PREFIX = 'TENANT#';

/**
 * Allowed shape of a `tenantId`. Mirrors the constraint used by the CP-4 key
 * resolver: 1–128 chars, must start alphanumeric, no slashes — so a tenantId
 * can never smuggle structure into the partition key.
 */
const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** True iff `tenantId` is a non-empty string safe to use as a tenant scope. */
export function isValidTenantId(tenantId: unknown): tenantId is string {
  return typeof tenantId === 'string' && TENANT_ID_PATTERN.test(tenantId);
}

/**
 * Thrown when a read is attempted without a usable tenant scope. Raised BEFORE
 * any DynamoDB call so an unscoped query never reaches the data plane.
 */
export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantScopeError';
  }
}

/**
 * Build the partition-key value for a tenant: `TENANT#<tenantId>`.
 * Throws {@link TenantScopeError} if the tenant scope is missing/invalid.
 */
export function tenantPartitionKey(tenantId: unknown): string {
  if (tenantId === undefined || tenantId === null || tenantId === '') {
    throw new TenantScopeError(
      'A tenant scope is required to build a query: tenantId was empty.',
    );
  }
  if (!isValidTenantId(tenantId)) {
    throw new TenantScopeError(
      `A tenant scope is required to build a query: invalid tenantId ` +
        `${JSON.stringify(tenantId)}.`,
    );
  }
  return `${TENANT_PK_PREFIX}${tenantId}`;
}

/** Sort-key conditions supported by the builder (single-tenant partition). */
export type SortKeyCondition =
  | { readonly kind: 'equals'; readonly value: string }
  | { readonly kind: 'beginsWith'; readonly prefix: string }
  | { readonly kind: 'between'; readonly lower: string; readonly upper: string }
  | { readonly kind: 'lessThan'; readonly value: string }
  | { readonly kind: 'lessThanOrEqual'; readonly value: string }
  | { readonly kind: 'greaterThan'; readonly value: string }
  | { readonly kind: 'greaterThanOrEqual'; readonly value: string };

/** Inputs for a single tenant-scoped read. */
export interface TenantQueryInput {
  /** Operative tenant — MUST come from a Validated_Session, never a client field. */
  readonly tenantId: string;
  /** Optional sort-key narrowing within the tenant partition. */
  readonly sortKey?: SortKeyCondition;
  /**
   * Optional additional filter expression applied server-side. It is layered
   * on top of (never instead of) the tenant key condition. Provide matching
   * `expressionAttributeValues` / `expressionAttributeNames`.
   */
  readonly filterExpression?: string;
  readonly expressionAttributeValues?: Record<string, unknown>;
  readonly expressionAttributeNames?: Record<string, string>;
  /** DynamoDB projection expression (attributes to return). */
  readonly projectionExpression?: string;
  /** Query a GSI/LSI instead of the base table (still tenant-pinned on PK). */
  readonly indexName?: string;
  readonly limit?: number;
  readonly consistentRead?: boolean;
  /** Sort direction; defaults to DynamoDB's ascending. */
  readonly scanIndexForward?: boolean;
  /** Pagination cursor from a previous page's LastEvaluatedKey. */
  readonly exclusiveStartKey?: Record<string, unknown>;
}

/** DynamoDB `Query` input shape (compatible with v2/v3 query commands). */
export interface DynamoQueryInput {
  TableName: string;
  IndexName?: string;
  KeyConditionExpression: string;
  FilterExpression?: string;
  ProjectionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues: Record<string, unknown>;
  Limit?: number;
  ConsistentRead?: boolean;
  ScanIndexForward?: boolean;
  ExclusiveStartKey?: Record<string, unknown>;
}

// Reserved placeholders the builder owns; user filters must not collide.
const PK_NAME_PLACEHOLDER = '#pk';
const SK_NAME_PLACEHOLDER = '#sk';
const PK_VALUE_PLACEHOLDER = ':pk';
const SK_VALUE_PLACEHOLDER = ':sk';
const SK_VALUE_PLACEHOLDER_UPPER = ':skUpper';

function sortKeyClause(cond: SortKeyCondition): {
  expression: string;
  values: Record<string, unknown>;
} {
  switch (cond.kind) {
    case 'equals':
      return {
        expression: `${SK_NAME_PLACEHOLDER} = ${SK_VALUE_PLACEHOLDER}`,
        values: { [SK_VALUE_PLACEHOLDER]: cond.value },
      };
    case 'beginsWith':
      return {
        expression: `begins_with(${SK_NAME_PLACEHOLDER}, ${SK_VALUE_PLACEHOLDER})`,
        values: { [SK_VALUE_PLACEHOLDER]: cond.prefix },
      };
    case 'between':
      return {
        expression: `${SK_NAME_PLACEHOLDER} BETWEEN ${SK_VALUE_PLACEHOLDER} AND ${SK_VALUE_PLACEHOLDER_UPPER}`,
        values: {
          [SK_VALUE_PLACEHOLDER]: cond.lower,
          [SK_VALUE_PLACEHOLDER_UPPER]: cond.upper,
        },
      };
    case 'lessThan':
      return {
        expression: `${SK_NAME_PLACEHOLDER} < ${SK_VALUE_PLACEHOLDER}`,
        values: { [SK_VALUE_PLACEHOLDER]: cond.value },
      };
    case 'lessThanOrEqual':
      return {
        expression: `${SK_NAME_PLACEHOLDER} <= ${SK_VALUE_PLACEHOLDER}`,
        values: { [SK_VALUE_PLACEHOLDER]: cond.value },
      };
    case 'greaterThan':
      return {
        expression: `${SK_NAME_PLACEHOLDER} > ${SK_VALUE_PLACEHOLDER}`,
        values: { [SK_VALUE_PLACEHOLDER]: cond.value },
      };
    case 'greaterThanOrEqual':
      return {
        expression: `${SK_NAME_PLACEHOLDER} >= ${SK_VALUE_PLACEHOLDER}`,
        values: { [SK_VALUE_PLACEHOLDER]: cond.value },
      };
    /* istanbul ignore next — exhaustive switch guard */
    default: {
      const _exhaustive: never = cond;
      throw new TenantScopeError(
        `Unsupported sort-key condition: ${JSON.stringify(_exhaustive)}.`,
      );
    }
  }
}

/**
 * Build a DynamoDB `Query` input pinned to a single tenant partition.
 *
 * The returned `KeyConditionExpression` always begins with
 * `#pk = :pk` where `:pk = TENANT#<tenantId>`; an optional sort-key condition is
 * AND-ed on. A missing/invalid tenant scope throws {@link TenantScopeError}
 * before anything is built, so no unscoped query can be produced.
 */
export function buildTenantQuery(
  tableName: string,
  input: TenantQueryInput,
): DynamoQueryInput {
  if (!tableName) {
    throw new TenantScopeError('A table name is required to build a query.');
  }
  // Throws TenantScopeError if the tenant scope is missing/invalid.
  const pkValue = tenantPartitionKey(input.tenantId);

  let keyConditionExpression = `${PK_NAME_PLACEHOLDER} = ${PK_VALUE_PLACEHOLDER}`;
  const names: Record<string, string> = {
    ...(input.expressionAttributeNames ?? {}),
    [PK_NAME_PLACEHOLDER]: 'PK',
  };
  const values: Record<string, unknown> = {
    ...(input.expressionAttributeValues ?? {}),
    [PK_VALUE_PLACEHOLDER]: pkValue,
  };

  if (input.sortKey) {
    const clause = sortKeyClause(input.sortKey);
    keyConditionExpression += ` AND ${clause.expression}`;
    names[SK_NAME_PLACEHOLDER] = 'SK';
    Object.assign(values, clause.values);
  }

  const query: DynamoQueryInput = {
    TableName: tableName,
    KeyConditionExpression: keyConditionExpression,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };

  if (input.indexName !== undefined) query.IndexName = input.indexName;
  if (input.filterExpression !== undefined) {
    query.FilterExpression = input.filterExpression;
  }
  if (input.projectionExpression !== undefined) {
    query.ProjectionExpression = input.projectionExpression;
  }
  if (input.limit !== undefined) query.Limit = input.limit;
  if (input.consistentRead !== undefined) {
    query.ConsistentRead = input.consistentRead;
  }
  if (input.scanIndexForward !== undefined) {
    query.ScanIndexForward = input.scanIndexForward;
  }
  if (input.exclusiveStartKey !== undefined) {
    query.ExclusiveStartKey = input.exclusiveStartKey;
  }

  return query;
}

/**
 * Read the `tenantId` off a returned item, accepting both DocumentClient
 * (plain `{ tenantId: 'acme' }`) and low-level attribute-value
 * (`{ tenantId: { S: 'acme' } }`) marshalling.
 */
function itemTenantId(item: Record<string, unknown>): string | undefined {
  const raw = item['tenantId'];
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && 'S' in (raw as Record<string, unknown>)) {
    const s = (raw as { S?: unknown }).S;
    return typeof s === 'string' ? s : undefined;
  }
  // Fall back to deriving it from the partition key `TENANT#<tenantId>`.
  const pk = item['PK'];
  const pkStr =
    typeof pk === 'string'
      ? pk
      : pk && typeof pk === 'object' && 'S' in (pk as Record<string, unknown>)
        ? ((pk as { S?: unknown }).S as string | undefined)
        : undefined;
  if (typeof pkStr === 'string' && pkStr.startsWith(TENANT_PK_PREFIX)) {
    return pkStr.slice(TENANT_PK_PREFIX.length);
  }
  return undefined;
}

/**
 * Defense-in-depth result filter: drop any item whose owning tenant is not
 * exactly `tenantId`. An item with no resolvable tenant is also dropped (it
 * cannot be proven to belong to the requesting tenant).
 */
export function filterTenantItems<T extends Record<string, unknown>>(
  tenantId: string,
  items: readonly T[] | undefined,
): T[] {
  if (!isValidTenantId(tenantId)) {
    throw new TenantScopeError(
      `Cannot filter results without a valid tenant scope: ` +
        `${JSON.stringify(tenantId)}.`,
    );
  }
  if (!items) return [];
  return items.filter((item) => itemTenantId(item) === tenantId);
}

/** Minimal DynamoDB query executor (v2 `.promise()` or v3 `.send` adapter). */
export interface DynamoQueryExecutor {
  query(
    input: DynamoQueryInput,
  ): Promise<{ Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> }>;
}

/** Result of a tenant-scoped read after defense-in-depth filtering. */
export interface TenantQueryResult<T extends Record<string, unknown>> {
  readonly items: T[];
  readonly lastEvaluatedKey?: Record<string, unknown>;
}

/**
 * Execute a tenant-scoped read end to end: build the pinned query, run it
 * through the provided executor, and filter the results so no cross-tenant
 * item is ever returned. The single entry point read paths should prefer.
 */
export async function queryTenant<T extends Record<string, unknown>>(
  executor: DynamoQueryExecutor,
  tableName: string,
  input: TenantQueryInput,
): Promise<TenantQueryResult<T>> {
  const query = buildTenantQuery(tableName, input);
  const response = await executor.query(query);
  const items = filterTenantItems(input.tenantId, response.Items as T[] | undefined);
  return { items, lastEvaluatedKey: response.LastEvaluatedKey };
}
