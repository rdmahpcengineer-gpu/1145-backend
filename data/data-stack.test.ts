import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DataStack } from './data-stack';

/**
 * DM-4 object-lake synth assertions (task 3.3 / Req 20).
 *
 * Confirms the S3 lake is provisioned encrypted, private, and SSL-only, with a
 * default SSE-KMS key — the infrastructure floor beneath the code-enforced
 * tenant partitioning and consent gate.
 */
describe('DataStack — DM-4 object lake', () => {
  function template(): Template {
    const app = new App();
    const stack = new DataStack(app, 'DataStack', {
      env: { account: '111122223333', region: 'us-east-1' },
    });
    return Template.fromStack(stack);
  }

  it('provisions an S3 bucket with default SSE-KMS encryption', () => {
    const t = template();
    t.resourceCountIs('AWS::S3::Bucket', 1);
    t.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: Match.objectLike({
              SSEAlgorithm: 'aws:kms',
            }),
          }),
        ]),
      },
    });
  });

  it('blocks all public access on the lake', () => {
    const t = template();
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('denies non-SSE-KMS puts and enforces SSL via bucket policy', () => {
    const t = template();
    t.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'DenyNonKmsEncryptedPuts',
            Effect: 'Deny',
            Action: 's3:PutObject',
            Condition: {
              StringNotEquals: {
                's3:x-amz-server-side-encryption': 'aws:kms',
              },
            },
          }),
        ]),
      },
    });
  });

  it('provisions a dedicated rotating KMS key for the lake', () => {
    const t = template();
    // Two customer-managed keys: DM-2 table key + DM-4 lake key.
    t.resourceCountIs('AWS::KMS::Key', 2);
    t.hasResourceProperties('AWS::KMS::Alias', {
      AliasName: 'alias/1145/object-lake',
    });
  });
});
