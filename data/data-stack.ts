import {
  RemovalPolicy,
  Stack,
  StackProps,
  aws_dynamodb as dynamodb,
  aws_ec2 as ec2,
  aws_elasticache as elasticache,
  aws_iam as iam,
  aws_kms as kms,
  aws_s3 as s3,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { WiringKeys, publishWiring } from '../shared/wiring';
import { EmbeddingStore } from './embedding/embedding-store-construct';

/** Cross-stack wiring key for the DM-3 embedding-store endpoint. */
const EMBEDDING_ENDPOINT_KEY = 'data/embedding-endpoint';

/**
 * DataStack — owns `data/**` (DM-1..4).
 *
 * Deployed FIRST (with the CP-4 KMS strategy in ControlPlaneStack): every other
 * stack depends on the DM-2 single table and per-tenant keys.
 *
 * Filled in by later tasks:
 *  - 2.1 DM-2 DynamoDB single table (exports table name via shared/wiring) ✅
 *  - 3.1 DM-1 Redis short-term store ✅
 *  - 3.2 DM-3 embedding store (pgvector on Aurora) ✅
 *  - 3.3 DM-4 S3 object lake + consent gate ✅
 */
export interface DataStackProps extends StackProps {}

export class DataStack extends Stack {
  /** DM-2 single table — every durable profile/order/call/lead/failure record. */
  readonly table: dynamodb.Table;

  /** KMS key encrypting the DM-2 table at rest. */
  readonly tableEncryptionKey: kms.Key;

  /** Network boundary for the DM-1 Redis short-term store (no public access). */
  readonly redisVpc: ec2.Vpc;

  /** Security group guarding access to the DM-1 Redis short-term store. */
  readonly redisSecurityGroup: ec2.SecurityGroup;

  /** DM-1 ElastiCache Redis replication group — short-term call memory. */
  readonly redisShortTermStore: elasticache.CfnReplicationGroup;

  /** DM-4 S3 object lake — recordings + documents, partitioned by tenant. */
  readonly objectLake: s3.Bucket;

  /** Default bucket-level SSE-KMS key for the object lake. */
  readonly objectLakeKey: kms.Key;

  /** DM-3 embedding store — pgvector on Aurora, tenant-tagged rows. */
  readonly embeddingStore: EmbeddingStore;

  constructor(scope: Construct, id: string, props?: DataStackProps) {
    super(scope, id, props);

    // --- DM-2 DynamoDB single table (design.md "Data Models") --------------
    //
    // Single-table design: all durable records (Booking, Order, Call, Lead,
    // Consent, Failure) share one table partitioned by `PK = TENANT#<tenantId>`
    // with an entity-specific `SK`. Item attributes `entityType`, `tenantId`,
    // `data`, and `createdAt` are written by the shared persistence wrapper
    // (task 2.3); DynamoDB only declares the key attributes (PK, SK) — the rest
    // are schemaless and recorded here for documentation:
    //
    //   PK         S  `TENANT#<tenantId>`              (partition key)
    //   SK         S  e.g. `BOOKING#<id>`, `ORDER#<id>` (sort key)
    //   entityType S  Booking | Order | Call | Lead | Consent | Failure
    //   tenantId   S  redundant scalar copy for filtering/validation
    //   data       M  entity payload
    //   createdAt  S  ISO-8601
    //
    // Encryption: the table is encrypted at rest with KMS. Per-item tenant data
    // additionally resolves through the CP-4 per-tenant key (task 2.2); this
    // table-level key protects the table as a whole.
    this.tableEncryptionKey = new kms.Key(this, 'DataTableKey', {
      description: '1145 AI DM-2 single-table encryption key',
      enableKeyRotation: true,
      alias: 'alias/1145/data-table',
    });

    this.table = new dynamodb.Table(this, 'DataTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.tableEncryptionKey,
      pointInTimeRecovery: true,
      // Durable profile/order store: retain on stack deletion so tenant data
      // is never lost by an accidental teardown.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Export the table name for cross-stack consumers (workflows, control
    // plane, agent, ml) via the shared wiring convention.
    publishWiring(this, WiringKeys.dataTableName, this.table.tableName);

    // --- DM-1 ElastiCache Redis short-term store (design.md "Data Models") -
    //
    // Holds within-call short-term memory for the AC-3 Memory component with
    // low latency. Entries are keyed `t:<tenantId>:call:<callId>:...` and carry
    // a call-lifetime TTL; the tenant-prefixed key namespace is what confines a
    // tenant's reads to its own keys (enforced in code by the `data/redis`
    // access module — see short_term_store.ts). This stack only provisions the
    // cluster; key construction and tenant-prefix confinement live in the
    // access module.
    //
    // Security posture:
    //  - Deployed into PRIVATE_ISOLATED subnets with NO public access and NO
    //    NAT — the cluster is unreachable from the internet.
    //  - The security group opens NO inbound rules here; consuming compute
    //    (AC-3 Memory) adds a scoped ingress rule from its own security group
    //    when it is wired up, so nothing can reach Redis by default.
    //  - At-rest and in-transit encryption are both enabled.
    this.redisVpc = new ec2.Vpc(this, 'RedisVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'redis-isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    this.redisSecurityGroup = new ec2.SecurityGroup(this, 'RedisSecurityGroup', {
      vpc: this.redisVpc,
      description:
        'DM-1 Redis short-term store — no inbound by default; consumers add scoped ingress',
      allowAllOutbound: true,
    });

    const redisSubnetGroup = new elasticache.CfnSubnetGroup(
      this,
      'RedisSubnetGroup',
      {
        description: 'Subnets for the DM-1 Redis short-term store',
        subnetIds: this.redisVpc.selectSubnets({
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        }).subnetIds,
      },
    );

    this.redisShortTermStore = new elasticache.CfnReplicationGroup(
      this,
      'RedisShortTermStore',
      {
        replicationGroupDescription: 'DM-1 short-term call memory (Redis)',
        engine: 'redis',
        cacheNodeType: 'cache.t4g.micro',
        // One primary + one replica for failover; isolation, not scale, is the
        // priority for short-term per-call memory.
        numCacheClusters: 2,
        automaticFailoverEnabled: true,
        multiAzEnabled: true,
        // Tenant data must be encrypted in transit and at rest.
        atRestEncryptionEnabled: true,
        transitEncryptionEnabled: true,
        port: 6379,
        cacheSubnetGroupName: redisSubnetGroup.ref,
        securityGroupIds: [this.redisSecurityGroup.securityGroupId],
      },
    );
    // L1 subnet group must exist before the replication group references it.
    this.redisShortTermStore.addDependency(redisSubnetGroup);

    // Export the Redis endpoint + port for cross-stack consumers (AC-3 Memory)
    // via the shared wiring convention.
    publishWiring(
      this,
      WiringKeys.redisPrimaryEndpoint,
      this.redisShortTermStore.attrPrimaryEndPointAddress,
    );
    publishWiring(
      this,
      WiringKeys.redisPort,
      this.redisShortTermStore.attrPrimaryEndPointPort,
    );

    // --- DM-4 S3 object lake (design.md "Data Models" / Req 20) ------------
    //
    // Holds Call recordings and tenant documents under a strictly
    // tenant-partitioned key layout:
    //
    //   s3://<lake>/<tenantId>/recordings/...
    //   s3://<lake>/<tenantId>/docs/...
    //
    // Encryption: objects are encrypted under the OWNING TENANT's CP-4 key
    // (SSE-KMS) — the per-object `SSEKMSKeyId` is set at PutObject time by the
    // object-lake access module (`data/lake`), resolved from the same
    // `tenantId` used to build the object-key prefix. The bucket carries a
    // default SSE-KMS key as a floor so an object can never land unencrypted,
    // and a bucket policy denies any put that is not SSE-KMS encrypted or that
    // travels over plaintext HTTP.
    //
    // The backend-enforced consent gate (assumption A1) lives in the access
    // module, not here: no IAM/infra primitive can express "audio only after
    // consent", so the check is performed in code immediately before the put.
    this.objectLakeKey = new kms.Key(this, 'ObjectLakeKey', {
      description: '1145 AI DM-4 object-lake default SSE-KMS key',
      enableKeyRotation: true,
      alias: 'alias/1145/object-lake',
    });

    this.objectLake = new s3.Bucket(this, 'ObjectLake', {
      // Tenant data lake: never publicly reachable.
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      // Default SSE-KMS floor; per-tenant CP-4 key applied per PutObject.
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.objectLakeKey,
      bucketKeyEnabled: true,
      enforceSSL: true,
      versioned: true,
      // Durable compliance store: retain on stack deletion.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Defense in depth: deny any PutObject that is not SSE-KMS encrypted, so
    // an object can never be written under S3-managed (SSE-S3) or no
    // encryption — every object must ride a KMS key (the tenant's CP-4 key).
    this.objectLake.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyNonKmsEncryptedPuts',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:PutObject'],
        resources: [this.objectLake.arnForObjects('*')],
        conditions: {
          StringNotEquals: {
            's3:x-amz-server-side-encryption': 'aws:kms',
          },
        },
      }),
    );

    // Export the bucket name for cross-stack consumers via shared wiring.
    publishWiring(
      this,
      WiringKeys.objectLakeBucketName,
      this.objectLake.bucketName,
    );

    // --- DM-3 embedding store (design.md "Data Models → DM-3" / Req 19) ----
    //
    // pgvector on Aurora PostgreSQL Serverless v2, encrypted at rest under the
    // data KMS key. Tenant isolation is enforced in software: every row is
    // tenant-tagged via `data/tagging`, and every similarity search carries a
    // mandatory `tenantId = :t` predicate built by `data/embedding`. The
    // construct provisions only the engine; it never issues unscoped queries.
    this.embeddingStore = new EmbeddingStore(this, 'EmbeddingStore', {
      encryptionKey: this.tableEncryptionKey,
    });

    // Export the embedding-store endpoint for cross-stack consumers (AC-3
    // memory, ML ingest) via the shared wiring convention.
    publishWiring(
      this,
      EMBEDDING_ENDPOINT_KEY,
      this.embeddingStore.endpoint,
    );
  }
}
