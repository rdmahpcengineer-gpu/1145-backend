/**
 * ml/ingest — ML-1 stream ingest.
 *
 * Exposes both the producer-side logic (tenant tagging + tenant-scoped
 * partition keys, reusing the shared `data/tagging` helper) and the CDK
 * construct that provisions the Kinesis stream.
 */
export * from './stream_ingest';
export * from './kinesis-ingest-construct';
