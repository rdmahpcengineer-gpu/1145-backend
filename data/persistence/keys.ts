/**
 * data/persistence/keys — tenant partition-key construction.
 *
 * Single source of truth for the DM-2 partition key format
 * `PK = TENANT#<tenantId>` (design.md "Data Models"; multi-tenant isolation
 * rule 1). Every write path goes through {@link tenantPartitionKey} so the
 * `TENANT#` prefix can never drift or be omitted.
 *
 * The `tenantId` validation is delegated to `data/crypto/tenant_key` so the
 * SAME notion of a valid tenant id governs both the partition key and the CP-4
 * KMS alias — a tenant id that is safe for the key is the one used for the `PK`.
 *
 * NOTE: This helper deliberately lives under `data/persistence/` (not a shared
 * data/ root) so it does not collide with the concurrent query-builder work
 * (task 2.4). The query builder may import from here if it wants the same
 * prefix/parse helpers.
 *
 * _Requirements: 5.1, 18.2_
 */

import { assertValidTenantId, isValidTenantId } from '../crypto/tenant_key';

/** The partition-key prefix carried by every persisted item. */
export const TENANT_PK_PREFIX = 'TENANT#';

/**
 * Build the DM-2 partition key for a tenant: `TENANT#<tenantId>`.
 *
 * Throws (via {@link assertValidTenantId}) if `tenantId` is missing or malformed
 * — the partition key can never be constructed without a valid tenant.
 */
export function tenantPartitionKey(tenantId: string): string {
  assertValidTenantId(tenantId);
  return `${TENANT_PK_PREFIX}${tenantId}`;
}

/** True iff `pk` is a well-formed tenant partition key `TENANT#<tenantId>`. */
export function isTenantPartitionKey(pk: unknown): pk is string {
  if (typeof pk !== 'string' || !pk.startsWith(TENANT_PK_PREFIX)) {
    return false;
  }
  return isValidTenantId(pk.slice(TENANT_PK_PREFIX.length));
}

/**
 * Extract the `tenantId` from a partition key, or `undefined` if `pk` is not a
 * well-formed tenant partition key.
 */
export function tenantIdFromPartitionKey(pk: unknown): string | undefined {
  return isTenantPartitionKey(pk) ? pk.slice(TENANT_PK_PREFIX.length) : undefined;
}
