/**
 * ml/training/registry-entry — construct + validate the ML-4 registry entry.
 *
 * Single source of truth for the `RegistryEntry` shape (design.md "Model
 * registry entry (ML-4)"):
 *
 *   RegistryEntry { modelVersion, metrics: { ...evalMetrics }, registeredAt }
 *
 * When a model is registered, the pipeline records (a) the evaluation metrics
 * (R23.2) and (b) a version-identifying entry (R23.3). This builder enforces
 * that both are present and well-formed before the entry is handed to the
 * registry, so the recorded entry always identifies a model version and carries
 * finite metrics.
 *
 * _Requirements: 23.2, 23.3_
 */

import { RegistryEntryError } from './errors';
import { EvalMetrics, RegistryEntry } from './types';

/** Input to {@link buildRegistryEntry}. */
export interface BuildRegistryEntryInput {
  /** The model version this entry identifies (R23.3). Non-empty. */
  modelVersion: string;
  /** Evaluation metrics recorded with the entry (R23.2). */
  metrics: EvalMetrics;
  /**
   * When the entry was recorded. Accepts a `Date` or an ISO-8601 string;
   * defaults to "now" when omitted. Always normalised to an ISO-8601 string.
   */
  registeredAt?: Date | string;
}

/**
 * Build a validated {@link RegistryEntry}.
 *
 * @throws {RegistryEntryError} when the version is missing/blank, the metrics
 * map contains a non-finite value, or `registeredAt` is not a valid timestamp.
 */
export function buildRegistryEntry(
  input: BuildRegistryEntryInput,
): RegistryEntry {
  const modelVersion = normalizeVersion(input.modelVersion);
  const metrics = normalizeMetrics(input.metrics);
  const registeredAt = normalizeRegisteredAt(input.registeredAt);

  return { modelVersion, metrics, registeredAt };
}

function normalizeVersion(version: unknown): string {
  if (typeof version !== 'string' || version.trim() === '') {
    throw new RegistryEntryError(
      'missing-model-version',
      `A registry entry must identify a model version; got ` +
        `${JSON.stringify(version)}.`,
    );
  }
  return version;
}

function normalizeMetrics(metrics: unknown): EvalMetrics {
  if (
    metrics === null ||
    typeof metrics !== 'object' ||
    Array.isArray(metrics)
  ) {
    throw new RegistryEntryError(
      'invalid-metrics',
      `Evaluation metrics must be an object map of name → number; got ` +
        `${JSON.stringify(metrics)}.`,
    );
  }
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(metrics as object)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new RegistryEntryError(
        'invalid-metrics',
        `Metric ${JSON.stringify(name)} must be a finite number; got ` +
          `${JSON.stringify(value)}.`,
      );
    }
    out[name] = value;
  }
  return Object.freeze(out);
}

function normalizeRegisteredAt(value: Date | string | undefined): string {
  if (value === undefined) {
    return new Date().toISOString();
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RegistryEntryError(
      'invalid-registered-at',
      `registeredAt must be a valid Date or ISO-8601 string; got ` +
        `${JSON.stringify(value)}.`,
    );
  }
  return date.toISOString();
}
