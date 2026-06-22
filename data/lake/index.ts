/**
 * data/lake — DM-4 object-lake access module.
 *
 * Public surface every audio/document write path consumes. Enforces tenant
 * partitioning (R20.1), tenant-KMS encryption (R20.3), and the backend
 * consent gate (A1 / R20.2) before any object reaches S3.
 */
export * from './errors';
export * from './keys';
export * from './consent';
export * from './object-lake';
