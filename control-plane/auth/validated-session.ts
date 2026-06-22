/**
 * control-plane/auth/validated-session — the two (and only two) shapes a
 * Validated_Session can take.
 *
 * The backend has exactly two trust boundaries through which a `tenantId` may
 * enter the system (design.md "Two trust boundaries, two session validators"):
 *
 *   1. A **Cognito** session (CP-1) for dashboard/REST traffic (CP-2, CP-3
 *      reads/subscriptions). Its tenant lives in the verified token claim
 *      `custom:tenantId`.
 *   2. An independently **validated SE-1** session (assumption A3) for voice
 *      traffic. Its tenant is the trusted `tenantId` emitted by the SE-1
 *      validator (`agent/session/se1_validator`, task 9.1) and is the only
 *      acceptable tenant source for an AC session or a Publish_Mutation.
 *
 * Nothing else may originate a tenant. A client-supplied tenant field is never
 * represented here — it is, by construction, not a source of truth.
 *
 * NOTE: this module is intentionally free of any `aws-cdk-lib` dependency so it
 * can run inside a Lambda authorizer/handler. The {@link TENANT_ID_CLAIM}
 * constant mirrors the value declared by the CP-1 Cognito construct
 * (`control-plane/cognito/tenant-user-pool.ts`); a unit test asserts the two
 * never drift.
 */

/**
 * The fully-qualified Cognito claim name that carries the operative tenant.
 *
 * Cognito surfaces declared custom attributes under the `custom:` namespace, so
 * the claim seen in a verified token is `custom:tenantId`. This MUST match
 * `TENANT_ID_CLAIM` exported by the CP-1 Cognito construct.
 */
export const TENANT_ID_CLAIM = 'custom:tenantId';

/** Discriminator values for the {@link ValidatedSession} union. */
export const SessionKind = {
  /** A verified CP-1 Cognito session (dashboard/REST). */
  Cognito: 'cognito',
  /** An independently validated SE-1 voice session (A3). */
  Se1: 'se1',
} as const;

export type SessionKind = (typeof SessionKind)[keyof typeof SessionKind];

/**
 * A verified CP-1 Cognito session. `claims` are the token claims AFTER the
 * Cognito authorizer has verified the token (signature/issuer/expiry); this
 * helper trusts them and reads the tenant from `custom:tenantId`.
 */
export interface CognitoValidatedSession {
  readonly kind: typeof SessionKind.Cognito;
  /** Verified token claims. The tenant is read from `custom:tenantId`. */
  readonly claims: Readonly<Record<string, unknown>>;
}

/**
 * An independently validated SE-1 session. `tenantId` is the trusted tenant
 * produced by the SE-1 validator (A3); the validator — not this helper — has
 * already verified signature/issuer/expiry and tenant existence.
 */
export interface Se1ValidatedSession {
  readonly kind: typeof SessionKind.Se1;
  /** The trusted tenant emitted by the SE-1 validator. */
  readonly tenantId: string;
}

/** The closed set of session shapes that may originate a tenant. */
export type ValidatedSession = CognitoValidatedSession | Se1ValidatedSession;

/**
 * Construct a Cognito Validated_Session from verified token claims. Use this at
 * the CP-2 authorizer / CP-3 resolver boundary so callers never hand-roll the
 * discriminated shape.
 */
export function cognitoSession(
  claims: Readonly<Record<string, unknown>>,
): CognitoValidatedSession {
  return { kind: SessionKind.Cognito, claims };
}

/**
 * Construct an SE-1 Validated_Session from a tenant already validated by the
 * SE-1 validator (A3). The tenant is not re-validated for trust here; it is
 * range-checked for shape when the operative tenant is derived.
 */
export function se1Session(tenantId: string): Se1ValidatedSession {
  return { kind: SessionKind.Se1, tenantId };
}

/** True iff `value` is a recognized {@link ValidatedSession}. */
export function isValidatedSession(value: unknown): value is ValidatedSession {
  if (!value || typeof value !== 'object') return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === SessionKind.Cognito || kind === SessionKind.Se1;
}
