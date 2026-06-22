/**
 * data/persistence/errors — typed errors for the tenant persistence wrapper.
 *
 * A {@link TenantScopeError} is raised when a write is attempted without a valid
 * tenant scope (no `tenantId` / no `TENANT#` partition key). It is thrown BEFORE
 * any request reaches DynamoDB, so an unscoped write can never be persisted
 * (design Property 2; multi-tenant isolation rule 2/3).
 *
 * _Requirements: 5.3, 18.4_
 */

/** Reasons a write was rejected for lacking a tenant scope. */
export type TenantScopeViolation =
  | 'missing-tenant-id'
  | 'invalid-tenant-id'
  | 'missing-partition-key'
  | 'malformed-partition-key'
  | 'tenant-mismatch';

/**
 * Thrown when a persistence operation lacks (or contradicts) its tenant scope.
 *
 * This is a domain/scope error, not a transient failure: it signals a
 * programming error or an attempt to bypass tenant isolation, and the operation
 * is refused without touching the data store.
 */
export class TenantScopeError extends Error {
  readonly violation: TenantScopeViolation;

  constructor(violation: TenantScopeViolation, message: string) {
    super(message);
    this.name = 'TenantScopeError';
    this.violation = violation;
    // Restore prototype chain for instanceof across transpilation targets.
    Object.setPrototypeOf(this, TenantScopeError.prototype);
  }
}
