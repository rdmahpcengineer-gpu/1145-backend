/**
 * ml/training/errors — typed errors for the ML-4 train→eval→register flow.
 *
 * These are domain/validation errors raised BEFORE an invalid entry is recorded
 * in the model registry, so a bad version or malformed metrics never reaches
 * the registry (R23.2, R23.3).
 *
 * _Requirements: 23.2, 23.3_
 */

/** Why a registry entry could not be constructed. */
export type RegistryEntryViolation =
  | 'missing-model-version'
  | 'invalid-metrics'
  | 'invalid-registered-at';

/**
 * Thrown when a {@link RegistryEntry} cannot be built with a valid
 * version-identifying shape and finite evaluation metrics.
 */
export class RegistryEntryError extends Error {
  readonly violation: RegistryEntryViolation;

  constructor(violation: RegistryEntryViolation, message: string) {
    super(message);
    this.name = 'RegistryEntryError';
    this.violation = violation;
    Object.setPrototypeOf(this, RegistryEntryError.prototype);
  }
}
