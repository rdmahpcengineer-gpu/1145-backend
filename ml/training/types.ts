/**
 * ml/training/types — shared shapes for the ML-4 train→eval→register flow.
 *
 * These types are the technology-neutral core of the SageMaker pipeline
 * (design.md "ML-4 — Model Pipeline" and "Model registry entry (ML-4)"). They
 * let the train→eval→register flow and the registry-entry construction be
 * exercised in tests without a live SageMaker pipeline.
 *
 * _Requirements: 23.1, 23.2, 23.3_
 */

/**
 * Evaluation metrics produced when a trained model is evaluated. An open map of
 * metric name → numeric value (e.g. `{ accuracy: 0.91, f1: 0.88 }`). Metric
 * values are finite numbers; the registry records the whole map (R23.2).
 */
export type EvalMetrics = Readonly<Record<string, number>>;

/**
 * A model-registry entry (design.md "Model registry entry (ML-4)").
 *
 * ```
 * RegistryEntry {
 *   modelVersion: string
 *   metrics: { ...evalMetrics }
 *   registeredAt: ISO-8601
 * }
 * ```
 *
 * - `modelVersion` identifies the registered model version (R23.3).
 * - `metrics` is the evaluation metrics recorded at registration (R23.2).
 * - `registeredAt` is an ISO-8601 timestamp of when the entry was recorded.
 */
export interface RegistryEntry {
  readonly modelVersion: string;
  readonly metrics: EvalMetrics;
  readonly registeredAt: string;
}

/**
 * A sink that records registry entries — the "model registry" of R23.2/R23.3.
 * The flow logic depends only on this interface, so an in-memory fake stands in
 * for SageMaker's model-package registry in tests.
 */
export interface ModelRegistry {
  /** Record a registry entry; returns the stored entry. */
  register(entry: RegistryEntry): RegistryEntry | Promise<RegistryEntry>;
}
