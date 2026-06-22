/**
 * data/persistence/tenant-persistence — the shared tenant persistence wrapper.
 *
 * Every durable write in the backend MUST go through this wrapper. It is the
 * single choke point that enforces the multi-tenant write invariants of the
 * DM-2 single table (design.md "Data Models"; multi-tenant isolation rules):
 *
 *   1. Every written item carries `PK = TENANT#<tenantId>` plus the redundant
 *      scalar `tenantId`, an `entityType`, and an ISO-8601 `createdAt`.
 *   2. A write that lacks a tenant partition key / `tenantId` is rejected with a
 *      {@link TenantScopeError} BEFORE the request reaches DynamoDB.
 *   3. The CP-4 KMS encryption context for the tenant is derived via
 *      `data/crypto/tenant_key` and attached to the write, so item-level
 *      encryption is conditioned on the same `tenantId` used for the `PK`.
 *
 * The wrapper depends on a narrow {@link DynamoDocumentWriter} interface rather
 * than the AWS SDK directly, so it is trivially unit-testable and free of
 * cloud coupling. At runtime a thin adapter over `DynamoDBDocumentClient` is
 * injected.
 *
 * _Requirements: 5.1, 5.3, 18.2, 18.4_
 */

import {
  assertValidTenantId,
  encryptionContextForTenant,
} from '../crypto/tenant_key';
import { TenantScopeError } from './errors';
import {
  TENANT_PK_PREFIX,
  isTenantPartitionKey,
  tenantIdFromPartitionKey,
  tenantPartitionKey,
} from './keys';

/** Entity kinds stored in the DM-2 single table (design "Data Models"). */
export type EntityType =
  | 'Booking'
  | 'Order'
  | 'Call'
  | 'Lead'
  | 'Consent'
  | 'Failure';

/** A fully-formed DM-2 item as written to DynamoDB. */
export interface PersistedItem {
  /** `TENANT#<tenantId>` — partition key, present on EVERY item. */
  PK: string;
  /** Entity sort key, e.g. `BOOKING#<id>`, `ORDER#<id>`. */
  SK: string;
  /** Discriminator for the entity payload. */
  entityType: EntityType;
  /** Redundant scalar copy of the tenant id for filtering/validation. */
  tenantId: string;
  /** Entity payload (shapes consistent with imported contracts). */
  data: Record<string, unknown>;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

/** Caller-facing description of a record to persist. */
export interface WriteRequest {
  /** Operative tenant — derived from a Validated_Session, never the client. */
  tenantId: string;
  /** Entity kind. */
  entityType: EntityType;
  /** Sort key for the item, e.g. `BOOKING#<id>`. */
  sk: string;
  /** Entity payload. */
  data: Record<string, unknown>;
  /**
   * Optional ISO-8601 timestamp; defaults to the current time. Useful for
   * deterministic tests and back-dated migrations.
   */
  createdAt?: string;
  /**
   * When true, the write only succeeds if no item already exists for this
   * `PK`/`SK` (a create, not an upsert). Surfaced via a DynamoDB condition
   * expression so it is enforced atomically by the store.
   */
  createOnly?: boolean;
}

/** Narrow DynamoDB document put input (decoupled from the AWS SDK). */
export interface PutItemInput {
  TableName: string;
  Item: PersistedItem;
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  /**
   * KMS encryption context derived from the tenant. Carried alongside the put
   * so the data-plane role can only use the tenant's CP-4 key while operating
   * in that tenant's context (design CP-4 / Property 8).
   */
  encryptionContext?: Record<string, string>;
}

/**
 * The minimal write surface the wrapper needs. A runtime adapter implements
 * this over `DynamoDBDocumentClient.send(new PutCommand(...))`.
 */
export interface DynamoDocumentWriter {
  put(input: PutItemInput): Promise<unknown>;
}

/**
 * Wraps all writes to the DM-2 single table, enforcing tenant partitioning and
 * scope rejection before anything reaches DynamoDB.
 */
export class TenantPersistence {
  constructor(
    private readonly tableName: string,
    private readonly writer: DynamoDocumentWriter,
    /** Injectable clock for deterministic timestamps in tests. */
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!tableName) {
      throw new Error('TenantPersistence requires a non-empty table name.');
    }
  }

  /**
   * Build (but do not write) the fully-formed DM-2 item for a request.
   *
   * Validates the tenant scope and stamps `PK`, `tenantId`, `entityType`, and
   * `createdAt`. Throws {@link TenantScopeError} if the tenant scope is missing
   * or malformed — this is the pre-DynamoDB rejection point.
   */
  buildItem(request: WriteRequest): PersistedItem {
    const { tenantId, entityType, sk } = request;

    if (tenantId === undefined || tenantId === null || tenantId === '') {
      throw new TenantScopeError(
        'missing-tenant-id',
        'Refusing to persist an item without a tenantId.',
      );
    }
    try {
      assertValidTenantId(tenantId);
    } catch {
      throw new TenantScopeError(
        'invalid-tenant-id',
        `Refusing to persist an item with an invalid tenantId: ${JSON.stringify(
          tenantId,
        )}.`,
      );
    }

    if (!entityType) {
      throw new TenantScopeError(
        'missing-partition-key',
        'Refusing to persist an item without an entityType.',
      );
    }
    if (typeof sk !== 'string' || sk.length === 0) {
      throw new TenantScopeError(
        'missing-partition-key',
        'Refusing to persist an item without a sort key (SK).',
      );
    }

    return {
      PK: tenantPartitionKey(tenantId),
      SK: sk,
      entityType,
      tenantId,
      data: request.data ?? {},
      createdAt: request.createdAt ?? this.now().toISOString(),
    };
  }

  /**
   * Persist a record. The item is built and scope-validated first; only a
   * fully tenant-partitioned item ever reaches the writer.
   */
  async put(request: WriteRequest): Promise<PersistedItem> {
    const item = this.buildItem(request);
    return this.putItem(item, { createOnly: request.createOnly === true });
  }

  /**
   * Persist a pre-built item. Use this only when a caller has already assembled
   * a {@link PersistedItem}; the item is re-validated so a hand-built item that
   * lacks tenant scope is still rejected before the write (design Property 2).
   */
  async putItem(
    item: PersistedItem,
    opts: { createOnly?: boolean } = {},
  ): Promise<PersistedItem> {
    assertTenantScoped(item);

    const input: PutItemInput = {
      TableName: this.tableName,
      Item: item,
      encryptionContext: encryptionContextForTenant(item.tenantId),
    };

    if (opts.createOnly) {
      // Atomic create: fail if an item already exists for this PK/SK.
      input.ConditionExpression =
        'attribute_not_exists(#pk) AND attribute_not_exists(#sk)';
      input.ExpressionAttributeNames = { '#pk': 'PK', '#sk': 'SK' };
    }

    await this.writer.put(input);
    return item;
  }
}

/**
 * Assert a pre-built item carries a consistent tenant scope: a well-formed
 * `TENANT#<tenantId>` partition key and a matching redundant `tenantId` scalar.
 * Throws {@link TenantScopeError} otherwise.
 */
export function assertTenantScoped(
  item: Partial<PersistedItem> | null | undefined,
): asserts item is PersistedItem {
  if (!item || typeof item !== 'object') {
    throw new TenantScopeError(
      'missing-partition-key',
      'Refusing to persist a null/undefined item.',
    );
  }

  if (item.PK === undefined || item.PK === null || item.PK === '') {
    throw new TenantScopeError(
      'missing-partition-key',
      `Refusing to persist an item without a "${TENANT_PK_PREFIX}" partition key.`,
    );
  }
  if (!isTenantPartitionKey(item.PK)) {
    throw new TenantScopeError(
      'malformed-partition-key',
      `Refusing to persist an item whose partition key is not a valid ` +
        `tenant key: ${JSON.stringify(item.PK)}.`,
    );
  }

  if (
    item.tenantId === undefined ||
    item.tenantId === null ||
    item.tenantId === ''
  ) {
    throw new TenantScopeError(
      'missing-tenant-id',
      'Refusing to persist an item without a tenantId scalar.',
    );
  }

  const pkTenant = tenantIdFromPartitionKey(item.PK);
  if (pkTenant !== item.tenantId) {
    throw new TenantScopeError(
      'tenant-mismatch',
      `Item tenantId (${JSON.stringify(item.tenantId)}) does not match its ` +
        `partition key tenant (${JSON.stringify(pkTenant)}).`,
    );
  }
}
