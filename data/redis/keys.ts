/**
 * data/redis/keys — tenant/call key construction for the DM-1 short-term store.
 *
 * Single source of truth for the Redis key format
 * `t:<tenantId>:call:<callId>:...` (design.md "DM-1 Redis — short-term store";
 * Requirement 17.2). Every short-term entry is namespaced under a tenant prefix
 * so that a read performed in tenant `T`'s context can be confined to `T`'s key
 * space and can never touch another tenant's keys (Requirement 17.3).
 *
 * The `tenantId`/`callId` validation mirrors the constraint used by the CP-4
 * key resolver and the DM-2 query builder (1–128 chars, must start
 * alphanumeric, no `:` / `/` separators) so an id can never smuggle structure
 * into the key and escape its `t:<tenantId>:call:<callId>:` namespace.
 *
 * Note: this prefix/validation helper is defined locally (rather than imported
 * from the persistence wrapper or query builder) so the Redis access path stays
 * independently owned; all data paths deliberately agree on the same notion of
 * a valid tenant id.
 *
 * _Requirements: 17.2, 17.3_
 */

/** Root namespace segment for every short-term key: `t`. */
export const TENANT_NAMESPACE = 't';

/** Segment marking a per-call sub-namespace: `call`. */
export const CALL_NAMESPACE = 'call';

/** Separator between key segments. */
export const KEY_SEPARATOR = ':';

/**
 * Allowed shape of a `tenantId` / `callId` embedded in a Redis key. 1–128
 * chars, must start alphanumeric, only `_`/`-` otherwise — notably NO `:` so an
 * id can never inject an extra key segment.
 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Thrown when a key cannot be built / a read cannot be confined because the
 * tenant or call scope is missing or malformed. Raised BEFORE any Redis command
 * is issued, so an unscoped or cross-tenant access can never reach the store.
 */
export class RedisScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedisScopeError';
    Object.setPrototypeOf(this, RedisScopeError.prototype);
  }
}

/** True iff `id` is a non-empty string safe to embed in a short-term key. */
export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function assertValidTenantId(tenantId: unknown): asserts tenantId is string {
  if (!isValidId(tenantId)) {
    throw new RedisScopeError(
      `A valid tenant scope is required: invalid tenantId ` +
        `${JSON.stringify(tenantId)}.`,
    );
  }
}

function assertValidCallId(callId: unknown): asserts callId is string {
  if (!isValidId(callId)) {
    throw new RedisScopeError(
      `A valid call scope is required: invalid callId ` +
        `${JSON.stringify(callId)}.`,
    );
  }
}

function assertValidSegment(segment: unknown): asserts segment is string {
  if (
    typeof segment !== 'string' ||
    segment.length === 0 ||
    segment.includes(KEY_SEPARATOR)
  ) {
    throw new RedisScopeError(
      `Invalid short-term key segment ${JSON.stringify(segment)}: segments ` +
        `must be non-empty and contain no "${KEY_SEPARATOR}".`,
    );
  }
}

/**
 * The tenant key prefix: `t:<tenantId>:`. Every key for the tenant begins with
 * this string; it is the boundary a read is confined to.
 */
export function tenantPrefix(tenantId: string): string {
  assertValidTenantId(tenantId);
  return `${TENANT_NAMESPACE}${KEY_SEPARATOR}${tenantId}${KEY_SEPARATOR}`;
}

/**
 * The per-call key prefix: `t:<tenantId>:call:<callId>:`. All entries for a
 * single call share this prefix, which is what a call-scoped read/clear targets.
 */
export function callPrefix(tenantId: string, callId: string): string {
  assertValidCallId(callId);
  return (
    `${tenantPrefix(tenantId)}${CALL_NAMESPACE}${KEY_SEPARATOR}` +
    `${callId}${KEY_SEPARATOR}`
  );
}

/**
 * Build a fully-qualified short-term key:
 * `t:<tenantId>:call:<callId>:<segment>[:<segment>...]`.
 *
 * Requires at least one trailing segment (the field being addressed). Throws
 * {@link RedisScopeError} if the tenant/call scope or any segment is invalid.
 */
export function shortTermKey(
  tenantId: string,
  callId: string,
  ...segments: string[]
): string {
  if (segments.length === 0) {
    throw new RedisScopeError(
      'A short-term key requires at least one field segment after the call scope.',
    );
  }
  segments.forEach(assertValidSegment);
  return `${callPrefix(tenantId, callId)}${segments.join(KEY_SEPARATOR)}`;
}

/**
 * Defense-in-depth guard: assert `key` lies within tenant `T`'s namespace
 * (`t:<tenantId>:`). Used on every read so a key resolved for one tenant can
 * never be read in another tenant's context (Requirement 17.3).
 */
export function assertWithinTenant(tenantId: string, key: unknown): asserts key is string {
  const prefix = tenantPrefix(tenantId);
  if (typeof key !== 'string' || !key.startsWith(prefix)) {
    throw new RedisScopeError(
      `Refusing to access key ${JSON.stringify(key)} in tenant ` +
        `${JSON.stringify(tenantId)}'s context: key is outside the tenant ` +
        `namespace "${prefix}".`,
    );
  }
}

/** True iff `key` is a string within tenant `T`'s namespace `t:<tenantId>:`. */
export function isWithinTenant(tenantId: string, key: unknown): key is string {
  if (!isValidId(tenantId)) return false;
  const prefix = `${TENANT_NAMESPACE}${KEY_SEPARATOR}${tenantId}${KEY_SEPARATOR}`;
  return typeof key === 'string' && key.startsWith(prefix);
}
