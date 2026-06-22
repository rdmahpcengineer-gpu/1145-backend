/**
 * control-plane/auth/tenant-derivation — the shared tenant-derivation helper.
 *
 * This is the SINGLE choke point through which the operative `tenantId` enters
 * the backend for any tenant-scoped operation (multi-tenant isolation rule 3;
 * design.md "Two trust boundaries"). Every CP-2 handler (task 6.x), CP-3
 * resolver (task 7.x), and tenant-scoped runtime path derives its tenant here
 * and nowhere else. Centralizing it is what makes design **Property 1** —
 * "tenant is derived from the validated session, never the client" — hold by
 * construction:
 *
 *   1. The operative tenant is read ONLY from a {@link ValidatedSession}:
 *      a verified Cognito `custom:tenantId` claim (CP-2/CP-3) or the trusted
 *      tenant emitted by the SE-1 validator (voice, A3).
 *   2. Any client-supplied tenant value is structurally ignored — it is never
 *      read, so it can never widen, narrow, or override the session tenant
 *      regardless of whether it is absent, equal, or conflicting.
 *   3. A request with no Validated_Session is rejected with a typed
 *      {@link AuthorizationError} BEFORE any tenant is derived or any data is
 *      touched (R1.5).
 *
 * Tenant-id shape validation is delegated to `data/crypto/tenant_key` so the
 * SAME notion of a valid tenant governs the session boundary, the DynamoDB
 * partition key, and the CP-4 KMS alias.
 *
 * _Requirements: 1.4, 1.5, 5.4_
 */

import { isValidTenantId } from '../../data/crypto/tenant_key';
import { AuthorizationError } from './errors';
import {
  SessionKind,
  TENANT_ID_CLAIM,
  ValidatedSession,
  isValidatedSession,
} from './validated-session';

/**
 * Derive the operative `tenantId` from a Validated_Session.
 *
 * @param session a Cognito or validated-SE-1 session; `null`/`undefined` and
 *                 unrecognized shapes are treated as "no Validated_Session".
 * @returns the trusted tenant carried by the session.
 * @throws {AuthorizationError} when no session is present, the session is not a
 *         recognized Validated_Session, it carries no tenant, or the tenant is
 *         malformed. No tenant is derived and no data is accessed on failure.
 */
export function deriveTenantId(
  session: ValidatedSession | null | undefined,
): string {
  if (session === null || session === undefined) {
    throw new AuthorizationError(
      'missing-session',
      'Refusing to derive a tenant: no Validated_Session was presented.',
    );
  }
  if (!isValidatedSession(session)) {
    throw new AuthorizationError(
      'unrecognized-session',
      'Refusing to derive a tenant: the session is not a recognized ' +
        'Validated_Session (expected a Cognito or validated SE-1 session).',
    );
  }

  switch (session.kind) {
    case SessionKind.Cognito: {
      const claimed = session.claims[TENANT_ID_CLAIM];
      if (claimed === undefined || claimed === null || claimed === '') {
        throw new AuthorizationError(
          'missing-tenant-claim',
          `Refusing to derive a tenant: the Cognito session carries no ` +
            `"${TENANT_ID_CLAIM}" claim.`,
        );
      }
      if (!isValidTenantId(claimed)) {
        throw new AuthorizationError(
          'invalid-tenant',
          `Refusing to derive a tenant: the "${TENANT_ID_CLAIM}" claim is not ` +
            `a valid tenant id: ${JSON.stringify(claimed)}.`,
        );
      }
      return claimed;
    }
    case SessionKind.Se1: {
      if (!isValidTenantId(session.tenantId)) {
        throw new AuthorizationError(
          'invalid-tenant',
          `Refusing to derive a tenant: the validated SE-1 session tenant is ` +
            `not a valid tenant id: ${JSON.stringify(session.tenantId)}.`,
        );
      }
      return session.tenantId;
    }
    /* istanbul ignore next — exhaustive switch guard */
    default: {
      const _exhaustive: never = session;
      throw new AuthorizationError(
        'unrecognized-session',
        `Refusing to derive a tenant: unsupported session ` +
          `${JSON.stringify(_exhaustive)}.`,
      );
    }
  }
}

/**
 * A request as it actually arrives at the backend: it carries a (possibly
 * absent) Validated_Session AND, separately, whatever tenant the client put on
 * the wire (a header, a body field, a GraphQL argument). This type exists to
 * make the isolation guarantee explicit and testable: the client-supplied
 * tenant is captured here only to demonstrate that it is **never read**.
 */
export interface TenantDerivationRequest {
  /** The Validated_Session, if any (Cognito or validated SE-1). */
  readonly session: ValidatedSession | null | undefined;
  /**
   * Any tenant value supplied by the client. DELIBERATELY IGNORED — present in
   * the type only so callers can pass it through this choke point and so tests
   * can assert it has no effect (design Property 1). It may be absent, equal to
   * the session tenant, or a conflicting value; the result is identical.
   */
  readonly clientSuppliedTenantId?: unknown;
}

/**
 * Derive the operative `tenantId` for an incoming request, ignoring any
 * client-supplied tenant value.
 *
 * This is the function CP-2 handlers and CP-3 resolvers should call: it makes
 * the "never from the client" rule (R1.4) impossible to get wrong, because the
 * `clientSuppliedTenantId` is structurally discarded and the tenant is derived
 * solely from {@link TenantDerivationRequest.session} via {@link deriveTenantId}.
 *
 * @throws {AuthorizationError} exactly as {@link deriveTenantId} does.
 */
export function deriveOperativeTenantId(
  request: TenantDerivationRequest,
): string {
  // request.clientSuppliedTenantId is intentionally never referenced.
  return deriveTenantId(request.session);
}
