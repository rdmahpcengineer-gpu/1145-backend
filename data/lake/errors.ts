/**
 * data/lake/errors — typed errors for the DM-4 object-lake access module.
 *
 * These are domain/scope errors, not transient failures. Each one is raised
 * BEFORE any S3 `PutObject` is issued, so a rejected store never writes an
 * object (design Property 20, Property 21; multi-tenant isolation rules).
 *
 * _Requirements: 20.1, 20.2, 20.3_
 */

/** Why an object-key (or its tenant prefix) was rejected. */
export type ObjectKeyViolation =
  | 'missing-tenant-id'
  | 'invalid-tenant-id'
  | 'missing-call-id'
  | 'missing-object-name'
  | 'invalid-object-name';

/**
 * Thrown when an object key cannot be built with a safe, tenant-prefixed
 * layout (`<tenantId>/recordings/...` or `<tenantId>/docs/...`).
 */
export class ObjectKeyError extends Error {
  readonly violation: ObjectKeyViolation;

  constructor(violation: ObjectKeyViolation, message: string) {
    super(message);
    this.name = 'ObjectKeyError';
    this.violation = violation;
    Object.setPrototypeOf(this, ObjectKeyError.prototype);
  }
}

/**
 * Thrown when audio is requested to be stored but recording consent for the
 * caller's jurisdiction is not captured/granted. The gate FAILS CLOSED: absent
 * or ambiguous consent raises this and no audio object is written (A1 / R20.2).
 */
export class ConsentNotCapturedError extends Error {
  /** The consent decision that caused the rejection. */
  readonly decision: 'absent' | 'denied' | 'ambiguous';
  readonly callId: string;
  readonly jurisdiction: string;

  constructor(
    decision: 'absent' | 'denied' | 'ambiguous',
    callId: string,
    jurisdiction: string,
  ) {
    super(
      `Refusing to store Call audio: recording consent for call ` +
        `${JSON.stringify(callId)} in jurisdiction ` +
        `${JSON.stringify(jurisdiction)} is "${decision}". ` +
        `Audio is stored only after consent is captured (fail-closed).`,
    );
    this.name = 'ConsentNotCapturedError';
    this.decision = decision;
    this.callId = callId;
    this.jurisdiction = jurisdiction;
    Object.setPrototypeOf(this, ConsentNotCapturedError.prototype);
  }
}
