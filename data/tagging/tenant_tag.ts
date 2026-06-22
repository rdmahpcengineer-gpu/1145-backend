/**
 * data/tagging/tenant_tag — the shared tenant-tagging helper.
 *
 * A single, store-agnostic choke point for "stamp a record with its owning
 * tenant, and refuse any record that is not tenant-tagged". It encodes the
 * cross-cutting tagging invariant behind design Property 22:
 *
 *   For any embedding stored in the embedding store (DM-3) AND any record
 *   ingested through the stream (ML-1), the persisted/ingested item carries a
 *   `tenantId` tag identifying its owning tenant.
 *
 * Because the same invariant governs two different subsystems, this helper is
 * deliberately general and has NO dependency on DynamoDB, pgvector, Kinesis, or
 * the AWS SDK. It is reused by:
 *   - DM-3 embedding store     (task 3.2, `data/embedding/**`)
 *   - ML-1 stream ingest       (task 19.1, `ml/**`)
 *
 * The notion of a "valid tenant id" is delegated to `data/crypto/tenant_key`
 * so the SAME constraint governs the tag, the DM-2 partition key, and the CP-4
 * KMS alias — a tenant id safe for the key is the one stamped as the tag.
 *
 * _Requirements: 19.2, 21.2_
 */

import { assertValidTenantId, isValidTenantId } from '../crypto/tenant_key';

/** The attribute under which the owning tenant is stamped on every record. */
export const TENANT_TAG_KEY = 'tenantId' as const;

/** A record that carries its owning tenant under {@link TENANT_TAG_KEY}. */
export type TenantTagged<T = Record<string, unknown>> = T & {
  readonly [TENANT_TAG_KEY]: string;
};

/** Reasons a record was rejected by the tenant-tagging helper. */
export type TenantTagViolation =
  | 'missing-tenant-id'
  | 'invalid-tenant-id'
  | 'missing-tag'
  | 'invalid-tag'
  | 'tenant-mismatch';

/**
 * Thrown when a record cannot be tenant-tagged, or when an untagged / wrongly
 * tagged record is presented where a tagged one is required. This is a
 * scope/programming error, not a transient failure: the record is refused
 * before it can be persisted or ingested.
 */
export class TenantTagError extends Error {
  readonly violation: TenantTagViolation;

  constructor(violation: TenantTagViolation, message: string) {
    super(message);
    this.name = 'TenantTagError';
    this.violation = violation;
    // Restore prototype chain for instanceof across transpilation targets.
    Object.setPrototypeOf(this, TenantTagError.prototype);
  }
}

/**
 * Stamp `record` with its owning tenant, returning a new tenant-tagged object.
 *
 * - Rejects a missing/invalid `tenantId` with a {@link TenantTagError} — a
 *   record can never be tagged without a valid tenant.
 * - If `record` already carries a `tenantId`, it must equal `tenantId`; a
 *   conflicting pre-existing tag is rejected (a record cannot be re-homed to a
 *   different tenant by tagging).
 *
 * The input is not mutated; the tag is authoritative and overwrites only an
 * already-matching value.
 */
export function tagWithTenant<T extends Record<string, unknown>>(
  tenantId: string,
  record: T,
): TenantTagged<T> {
  if (tenantId === undefined || tenantId === null || (tenantId as string) === '') {
    throw new TenantTagError(
      'missing-tenant-id',
      'Refusing to tag a record without a tenantId.',
    );
  }
  try {
    assertValidTenantId(tenantId);
  } catch {
    throw new TenantTagError(
      'invalid-tenant-id',
      `Refusing to tag a record with an invalid tenantId: ${JSON.stringify(
        tenantId,
      )}.`,
    );
  }

  if (record === null || typeof record !== 'object') {
    throw new TenantTagError(
      'missing-tag',
      'Refusing to tag a null/undefined or non-object record.',
    );
  }

  const existing = (record as Record<string, unknown>)[TENANT_TAG_KEY];
  if (existing !== undefined && existing !== tenantId) {
    throw new TenantTagError(
      'tenant-mismatch',
      `Record already tagged with tenantId ${JSON.stringify(existing)}, ` +
        `cannot re-tag as ${JSON.stringify(tenantId)}.`,
    );
  }

  return { ...record, [TENANT_TAG_KEY]: tenantId } as TenantTagged<T>;
}

/** Read the tenant tag off a record, or `undefined` if it is not tagged. */
export function tenantTagOf(record: unknown): string | undefined {
  if (record === null || typeof record !== 'object') return undefined;
  const tag = (record as Record<string, unknown>)[TENANT_TAG_KEY];
  return isValidTenantId(tag) ? tag : undefined;
}

/** True iff `record` carries a well-formed `tenantId` tag. */
export function isTenantTagged(record: unknown): record is TenantTagged {
  return tenantTagOf(record) !== undefined;
}

/**
 * Assert `record` is tenant-tagged, narrowing its type. Throws
 * {@link TenantTagError} otherwise — the gate every persist/ingest path runs an
 * item through so an untagged record can never reach the store/stream.
 *
 * When `expectedTenantId` is supplied, the record's tag must also equal it
 * (defense in depth against a record carrying a foreign tenant's tag).
 */
export function assertTenantTagged<T extends Record<string, unknown>>(
  record: T | null | undefined,
  expectedTenantId?: string,
): asserts record is TenantTagged<T> {
  if (record === null || record === undefined || typeof record !== 'object') {
    throw new TenantTagError(
      'missing-tag',
      'Refusing to accept a null/undefined or non-object record.',
    );
  }

  const tag = (record as Record<string, unknown>)[TENANT_TAG_KEY];
  if (tag === undefined || tag === null || tag === '') {
    throw new TenantTagError(
      'missing-tag',
      'Refusing to accept an untagged record (no tenantId tag).',
    );
  }
  if (!isValidTenantId(tag)) {
    throw new TenantTagError(
      'invalid-tag',
      `Refusing to accept a record with an invalid tenantId tag: ` +
        `${JSON.stringify(tag)}.`,
    );
  }
  if (expectedTenantId !== undefined && tag !== expectedTenantId) {
    throw new TenantTagError(
      'tenant-mismatch',
      `Record tenantId tag ${JSON.stringify(tag)} does not match the ` +
        `expected tenant ${JSON.stringify(expectedTenantId)}.`,
    );
  }
}
