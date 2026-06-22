import {
  Duration,
  RemovalPolicy,
  aws_kinesis as kinesis,
  aws_kms as kms,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * KinesisIngestStream — the ML-1 stream-ingest construct.
 *
 * Provisions the Kinesis stream that ingests call-turn data (design.md
 * "ML → ML-1"). Records are produced by the AC runtime through the
 * `ml/ingest/stream_ingest` producer, which tags every record with `tenantId`
 * and keys it by a tenant-scoped partition key — tenant isolation is enforced
 * in software (the same pattern as DM-3), so this construct only provisions the
 * stream and its at-rest encryption.
 *
 * The stream is encrypted at rest with KMS: a caller-supplied CP-4 key family
 * key when given, otherwise the AWS-managed Kinesis key as a floor so call data
 * is never stored unencrypted.
 *
 * Scoped to task 19.1 — added in its OWN module so it does not collide with the
 * concurrent ML-2 (sentiment) / ML-4 (SageMaker) work in MlStack.
 *
 * _Requirements: 21.1, 21.2_
 */
export interface KinesisIngestStreamProps {
  /** KMS key to encrypt the stream at rest; falls back to AWS-managed KMS. */
  readonly encryptionKey?: kms.IKey;
  /** Provisioned shard count (defaults to 1). */
  readonly shardCount?: number;
  /** How long records are retained on the stream (defaults to 24h). */
  readonly retention?: Duration;
  /** Optional explicit stream name. */
  readonly streamName?: string;
}

export class KinesisIngestStream extends Construct {
  /** The ML-1 Kinesis stream ingesting tenant-tagged call-turn data. */
  readonly stream: kinesis.Stream;

  constructor(scope: Construct, id: string, props: KinesisIngestStreamProps = {}) {
    super(scope, id);

    this.stream = new kinesis.Stream(this, 'Stream', {
      streamName: props.streamName,
      shardCount: props.shardCount ?? 1,
      retentionPeriod: props.retention ?? Duration.hours(24),
      // Call data must be encrypted at rest. Use a provided CP-4-family key when
      // supplied, otherwise the AWS-managed Kinesis key as an encryption floor.
      encryption: props.encryptionKey
        ? kinesis.StreamEncryption.KMS
        : kinesis.StreamEncryption.MANAGED,
      encryptionKey: props.encryptionKey,
      // Transient ingest buffer (not the durable store) — safe to remove with
      // the stack; durable copies live in DM-2/DM-4.
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }

  /** Convenience accessor for cross-stack wiring (stream name). */
  get streamName(): string {
    return this.stream.streamName;
  }
}
