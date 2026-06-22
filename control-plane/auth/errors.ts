/**
 * control-plane/auth/errors — typed authorization errors for tenant derivation.
 *
 * An {@link AuthorizationError} is raised when the operative `tenantId` cannot
 * be derived from a trustworthy Validated_Session: there is no validated
 * session at all, the session carries no tenant, or the tenant it carries is
 * malformed. It is thrown BEFORE any handler/resolver logic runs and before any
 * data is touched, so an unauthenticated/unscoped request can never derive a
 * tenant (design.md "Error Handling"; design Property 2).
 *
 * This is the authorization counterpart to `data/persistence`'s
 * {@link TenantScopeError} (which guards the data plane): this error guards the
 * boundary where a tenant first enters the system.
 *
 * _Requirements: 1.5_
 */

/** Why a request failed to yield an operative tenant. */
export type AuthorizationFailure =
  /** No Validated_Session was presented (R1.5: reject with an auth error). */
  | 'missing-session'
  /** Session shape was not a recognized Validated_Session. */
  | 'unrecognized-session'
  /** A Cognito Validated_Session carried no `custom:tenantId` claim. */
  | 'missing-tenant-claim'
  /** A tenant value was present but is not a valid tenant id. */
  | 'invalid-tenant';

/**
 * Thrown when no operative `tenantId` can be derived from a Validated_Session.
 *
 * This is an authorization error, not a transient failure: it signals a missing
 * or untrustworthy session, and the request is refused without deriving a
 * tenant or performing any data access.
 */
export class AuthorizationError extends Error {
  readonly reason: AuthorizationFailure;

  constructor(reason: AuthorizationFailure, message: string) {
    super(message);
    this.name = 'AuthorizationError';
    this.reason = reason;
    // Restore prototype chain for instanceof across transpilation targets.
    Object.setPrototypeOf(this, AuthorizationError.prototype);
  }
}
