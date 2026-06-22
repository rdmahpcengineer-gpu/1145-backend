import { Stack, aws_kms as kms } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { EmbeddingStore } from './embedding-store-construct';

/**
 * Synth/snapshot tests for the DM-3 embedding-store construct. The construct is
 * exercised in an isolated test stack so it does not couple to the concurrent
 * DM-1/DM-4 work in DataStack.
 */
function synth(): Template {
  const stack = new Stack(undefined, 'TestStack', {
    env: { account: '111122223333', region: 'us-east-1' },
  });
  const key = new kms.Key(stack, 'Key');
  new EmbeddingStore(stack, 'EmbeddingStore', { encryptionKey: key });
  return Template.fromStack(stack);
}

describe('EmbeddingStore construct (DM-3, Req 19.1)', () => {
  it('provisions an Aurora PostgreSQL cluster (pgvector host)', () => {
    const t = synth();
    t.hasResourceProperties('AWS::RDS::DBCluster', {
      Engine: 'aurora-postgresql',
    });
  });

  it('encrypts cluster storage at rest under a KMS key', () => {
    const t = synth();
    t.hasResourceProperties('AWS::RDS::DBCluster', {
      StorageEncrypted: true,
      KmsKeyId: Match.anyValue(),
    });
  });

  it('runs Serverless v2 with a bounded capacity range', () => {
    const t = synth();
    t.hasResourceProperties('AWS::RDS::DBCluster', {
      ServerlessV2ScalingConfiguration: {
        MinCapacity: 0.5,
        MaxCapacity: 2,
      },
    });
  });

  it('runs in an isolated VPC with no NAT gateways', () => {
    const t = synth();
    t.resourceCountIs('AWS::EC2::VPC', 1);
    t.resourceCountIs('AWS::EC2::NatGateway', 0);
  });

  it('exposes the writer endpoint hostname', () => {
    const stack = new Stack(undefined, 'EndpointStack', {
      env: { account: '111122223333', region: 'us-east-1' },
    });
    const key = new kms.Key(stack, 'Key');
    const store = new EmbeddingStore(stack, 'EmbeddingStore', { encryptionKey: key });
    expect(store.endpoint).toBeDefined();
    expect(store.databaseName).toBe('embeddings');
  });
});
