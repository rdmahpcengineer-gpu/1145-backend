import { Stack, aws_kms as kms } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { KinesisIngestStream } from './kinesis-ingest-construct';

/**
 * Synth/snapshot tests for the ML-1 Kinesis ingest construct. Exercised in an
 * isolated test stack so it does not couple to the concurrent ML-2 / ML-4 work
 * in MlStack.
 */
function synth(build: (stack: Stack) => void): Template {
  const stack = new Stack(undefined, 'TestStack', {
    env: { account: '111122223333', region: 'us-east-1' },
  });
  build(stack);
  return Template.fromStack(stack);
}

describe('KinesisIngestStream construct (ML-1, Req 21.1)', () => {
  it('provisions a single Kinesis stream', () => {
    const t = synth((s) => {
      new KinesisIngestStream(s, 'IngestStream');
    });
    t.resourceCountIs('AWS::Kinesis::Stream', 1);
  });

  it('encrypts the stream at rest (AWS-managed KMS floor by default)', () => {
    const t = synth((s) => {
      new KinesisIngestStream(s, 'IngestStream');
    });
    t.hasResourceProperties('AWS::Kinesis::Stream', {
      StreamEncryption: Match.objectLike({
        EncryptionType: 'KMS',
      }),
    });
  });

  it('encrypts the stream under a supplied CP-4-family KMS key when given', () => {
    const t = synth((s) => {
      const key = new kms.Key(s, 'IngestKey');
      new KinesisIngestStream(s, 'IngestStream', { encryptionKey: key });
    });
    t.resourceCountIs('AWS::KMS::Key', 1);
    t.hasResourceProperties('AWS::Kinesis::Stream', {
      StreamEncryption: Match.objectLike({
        EncryptionType: 'KMS',
        KeyId: Match.anyValue(),
      }),
    });
  });

  it('honours an explicit shard count', () => {
    const t = synth((s) => {
      new KinesisIngestStream(s, 'IngestStream', { shardCount: 3 });
    });
    t.hasResourceProperties('AWS::Kinesis::Stream', {
      ShardCount: 3,
    });
  });

  it('exposes the stream name for cross-stack wiring', () => {
    const stack = new Stack(undefined, 'NameStack', {
      env: { account: '111122223333', region: 'us-east-1' },
    });
    const ingest = new KinesisIngestStream(stack, 'IngestStream');
    expect(ingest.streamName).toBeDefined();
    expect(ingest.stream).toBeDefined();
  });
});
